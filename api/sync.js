const { Pool } = require('pg');
const fetch = require('node-fetch');
const Redis = require('redis');

// Database connections
const primaryPool = new Pool({
  host: process.env.DB_PRIMARY_HOST || 'data.dlux.io',
  port: process.env.DB_PRIMARY_PORT || 5432,
  database: process.env.DB_PRIMARY_NAME || 'postgres',
  user: process.env.DB_PRIMARY_USER,
  password: process.env.DB_PRIMARY_PASSWORD,
  ssl: false // Disable SSL for data.dlux.io as it doesn't support SSL connections
});

const replicaPool = new Pool({
  host: process.env.DB_REPLICA_HOST || 'db_replica',
  port: process.env.DB_REPLICA_PORT || 5432,
  database: process.env.DB_REPLICA_NAME || 'dlux_presence',
  user: process.env.DB_REPLICA_USER || 'replica_user',
  password: process.env.DB_REPLICA_PASSWORD,
  ssl: false
});

const redis = Redis.createClient({
  url: `redis://${process.env.REDIS_HOST || 'redis'}:${process.env.REDIS_PORT || 6379}`,
  socket: {
    reconnectStrategy: (retries) => Math.min(retries * 50, 500)
  }
});

// Handle Redis connection events
redis.on('error', (err) => console.error('Redis Client Error:', err));
redis.on('connect', () => console.log('Redis Client Connected'));
redis.on('ready', () => console.log('Redis Client Ready'));

// Connect to Redis
redis.connect().catch(console.error);

const DLUX_API_URL = process.env.DLUX_API_URL || 'https://data.dlux.io';

console.log('DLUX Presence Sync Service Starting...');

// ==================================================================
// SYNC FUNCTIONS
// ==================================================================

async function syncPosts() {
  try {
    console.log('Syncing posts from data.dlux.io...');
    
    // Get latest posts from primary database
    const query = `
      SELECT author, permlink, block, votes, type, rating, nsfw, hidden, flagged,
             COALESCE(title, permlink) as title,
             LEFT(COALESCE(content, ''), 1000) as content,
             created_at, updated_at
      FROM posts 
      WHERE type IN ('360', 'vrml', 'aframe', 'blog', 'art', 'game')
        AND updated_at > NOW() - INTERVAL '1 hour'
      ORDER BY updated_at DESC
      LIMIT 1000
    `;
    
    const result = await primaryPool.query(query);
    
    if (result.rows.length === 0) {
      console.log('No recent posts to sync');
      return;
    }
    
    // Upsert into replica
    for (const post of result.rows) {
      await replicaPool.query(`
        INSERT INTO posts (author, permlink, block, votes, type, rating, nsfw, hidden, flagged, title, content, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        ON CONFLICT (author, permlink) DO UPDATE SET
          block = EXCLUDED.block,
          votes = EXCLUDED.votes,
          type = EXCLUDED.type,
          rating = EXCLUDED.rating,
          nsfw = EXCLUDED.nsfw,
          hidden = EXCLUDED.hidden,
          flagged = EXCLUDED.flagged,
          title = EXCLUDED.title,
          content = EXCLUDED.content,
          updated_at = EXCLUDED.updated_at
      `, [
        post.author, post.permlink, post.block, post.votes, post.type,
        post.rating, post.nsfw, post.hidden, post.flagged, post.title,
        post.content, post.created_at, post.updated_at
      ]);
    }
    
    console.log(`Synced ${result.rows.length} posts`);
    await redis.set('sync:posts:last_run', Date.now());
    
  } catch (error) {
    console.error('Error syncing posts:', error);
  }
}

async function syncCollaborationDocuments() {
  try {
    console.log('Syncing collaboration documents...');
    
    const query = `
      SELECT id, title, content, creator, is_public, created_at, updated_at
      FROM collaboration_documents
      WHERE updated_at > NOW() - INTERVAL '1 hour'
      ORDER BY updated_at DESC
      LIMIT 500
    `;
    
    const result = await primaryPool.query(query);
    
    if (result.rows.length === 0) {
      console.log('No recent documents to sync');
      return;
    }
    
    for (const doc of result.rows) {
      await replicaPool.query(`
        INSERT INTO collaboration_documents (id, title, content, creator, is_public, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (id) DO UPDATE SET
          title = EXCLUDED.title,
          content = EXCLUDED.content,
          creator = EXCLUDED.creator,
          is_public = EXCLUDED.is_public,
          updated_at = EXCLUDED.updated_at
      `, [doc.id, doc.title, doc.content, doc.creator, doc.is_public, doc.created_at, doc.updated_at]);
    }
    
    console.log(`Synced ${result.rows.length} documents`);
    await redis.set('sync:documents:last_run', Date.now());
    
  } catch (error) {
    console.error('Error syncing documents:', error);
  }
}

async function syncCollaborationPermissions() {
  try {
    console.log('Syncing document permissions...');
    
    const query = `
      SELECT id, document_id, user_account, permission, granted_by, created_at
      FROM collaboration_permissions
      WHERE created_at > NOW() - INTERVAL '1 hour'
      ORDER BY created_at DESC
    `;
    
    const result = await primaryPool.query(query);
    
    if (result.rows.length === 0) {
      console.log('No recent permissions to sync');
      return;
    }
    
    for (const perm of result.rows) {
      await replicaPool.query(`
        INSERT INTO collaboration_permissions (id, document_id, user_account, permission, granted_by, created_at)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (id) DO UPDATE SET
          permission = EXCLUDED.permission,
          granted_by = EXCLUDED.granted_by
      `, [perm.id, perm.document_id, perm.user_account, perm.permission, perm.granted_by, perm.created_at]);
    }
    
    console.log(`Synced ${result.rows.length} permissions`);
    await redis.set('sync:permissions:last_run', Date.now());
    
  } catch (error) {
    console.error('Error syncing permissions:', error);
  }
}

// ==================================================================
// WEBHOOK NOTIFICATIONS
// ==================================================================

async function notifyWebhooks(eventType, spaceType, spaceId, eventData) {
  try {
    const query = `
      SELECT webhook_url, secret, events
      FROM webhook_subscriptions
      WHERE space_type = $1 AND space_id = $2 AND is_active = true
        AND $3 = ANY(events)
    `;
    
    const result = await replicaPool.query(query, [spaceType, spaceId, eventType]);
    
    for (const webhook of result.rows) {
      const payload = {
        event: eventType,
        space_type: spaceType,
        space_id: spaceId,
        timestamp: new Date().toISOString(),
        data: eventData
      };
      
      const signature = webhook.secret ? 
        require('crypto').createHmac('sha256', webhook.secret)
          .update(JSON.stringify(payload))
          .digest('hex') : null;
      
      const headers = {
        'Content-Type': 'application/json',
        'User-Agent': 'DLUX-Presence-Webhook/1.0'
      };
      
      if (signature) {
        headers['X-DLUX-Signature'] = `sha256=${signature}`;
      }
      
      try {
        await fetch(webhook.webhook_url, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          timeout: 10000
        });
        
        console.log(`Webhook sent to ${webhook.webhook_url} for ${eventType}`);
      } catch (webhookError) {
        console.error(`Webhook failed for ${webhook.webhook_url}:`, webhookError.message);
      }
    }
  } catch (error) {
    console.error('Error sending webhooks:', error);
  }
}

// ==================================================================
// CACHE MANAGEMENT
// ==================================================================

async function updateSpaceCache() {
  try {
    console.log('Updating space activity cache...');
    
    // Cache popular spaces
    const popularQuery = `
      SELECT space_type, space_id, COUNT(*) as user_count
      FROM presence_sessions
      WHERE last_activity > NOW() - INTERVAL '1 hour'
      GROUP BY space_type, space_id
      ORDER BY user_count DESC
      LIMIT 20
    `;
    
    const popularResult = await replicaPool.query(popularQuery);
    await redis.set('cache:popular_spaces', JSON.stringify(popularResult.rows), 'EX', 300); // 5 min cache
    
    // Cache recent activity
    const activityQuery = `
      SELECT space_type, space_id, activity_type, COUNT(*) as count
      FROM space_activity
      WHERE created_at > NOW() - INTERVAL '1 hour'
        AND is_public = true
      GROUP BY space_type, space_id, activity_type
      ORDER BY count DESC
      LIMIT 50
    `;
    
    const activityResult = await replicaPool.query(activityQuery);
    await redis.set('cache:recent_activity', JSON.stringify(activityResult.rows), 'EX', 300);
    
    console.log('Space cache updated');
    
  } catch (error) {
    console.error('Error updating cache:', error);
  }
}

// ==================================================================
// CLEANUP TASKS
// ==================================================================

async function cleanupOldData() {
  try {
    console.log('Running cleanup tasks...');
    
    // Clean old sessions
    const sessionCleanup = await replicaPool.query(`
      DELETE FROM presence_sessions 
      WHERE last_activity < NOW() - INTERVAL '2 hours'
    `);
    
    // Clean old activity logs
    const activityCleanup = await replicaPool.query(`
      DELETE FROM space_activity 
      WHERE created_at < NOW() - INTERVAL '30 days'
    `);
    
    // Clean old chat messages (keep for 90 days)
    const chatCleanup = await replicaPool.query(`
      UPDATE chat_messages 
      SET content = '[deleted]', is_deleted = true
      WHERE created_at < NOW() - INTERVAL '90 days' AND NOT is_deleted
    `);
    
    console.log(`Cleanup: ${sessionCleanup.rowCount} sessions, ${activityCleanup.rowCount} activities, ${chatCleanup.rowCount} old messages`);
    
  } catch (error) {
    console.error('Error in cleanup:', error);
  }
}

// ==================================================================
// MONITORING AND HEALTH
// ==================================================================

async function logSyncStatus() {
  try {
    const status = {
      timestamp: new Date().toISOString(),
      primary_db: await testConnection(primaryPool),
      replica_db: await testConnection(replicaPool),
      redis: await testRedisConnection(),
      active_sessions: await getActiveSessionCount(),
      spaces_count: await getSpacesCount()
    };
    
    console.log('Sync Status:', JSON.stringify(status, null, 2));
    await redis.set('sync:status', JSON.stringify(status), 'EX', 300);
    
  } catch (error) {
    console.error('Error logging sync status:', error);
  }
}

async function testConnection(pool) {
  try {
    const result = await pool.query('SELECT 1');
    return { status: 'connected', timestamp: new Date().toISOString() };
  } catch (error) {
    return { status: 'error', error: error.message };
  }
}

async function testRedisConnection() {
  try {
    await redis.ping();
    return { status: 'connected', timestamp: new Date().toISOString() };
  } catch (error) {
    return { status: 'error', error: error.message };
  }
}

async function getActiveSessionCount() {
  try {
    const result = await replicaPool.query(`
      SELECT COUNT(*) as count
      FROM presence_sessions
      WHERE last_activity > NOW() - INTERVAL '5 minutes'
    `);
    return parseInt(result.rows[0].count);
  } catch (error) {
    return 0;
  }
}

async function getSpacesCount() {
  try {
    const result = await replicaPool.query(`
      SELECT 
        (SELECT COUNT(*) FROM posts WHERE type IN ('360', 'vrml', 'aframe', 'blog', 'art', 'game') AND NOT hidden AND NOT flagged) as posts,
        (SELECT COUNT(*) FROM collaboration_documents WHERE is_public = true) as documents
    `);
    return result.rows[0];
  } catch (error) {
    return { posts: 0, documents: 0 };
  }
}

// ==================================================================
// MAIN SYNC LOOP
// ==================================================================

async function runSyncCycle() {
  console.log('Starting sync cycle...');
  
  try {
    await Promise.all([
      syncPosts(),
      syncCollaborationDocuments(),
      syncCollaborationPermissions()
    ]);
    
    await updateSpaceCache();
    await logSyncStatus();
    
    console.log('Sync cycle completed successfully');
    
  } catch (error) {
    console.error('Error in sync cycle:', error);
  }
}

async function runCleanupCycle() {
  console.log('Starting cleanup cycle...');
  
  try {
    await cleanupOldData();
    console.log('Cleanup cycle completed');
    
  } catch (error) {
    console.error('Error in cleanup cycle:', error);
  }
}

// ==================================================================
// STARTUP AND SCHEDULING
// ==================================================================

async function startup() {
  console.log('DLUX Presence Sync Service initializing...');
  
  // Test connections
  console.log('Testing database connections...');
  const primaryStatus = await testConnection(primaryPool);
  const replicaStatus = await testConnection(replicaPool);
  const redisStatus = await testRedisConnection();
  
  console.log('Primary DB:', primaryStatus);
  console.log('Replica DB:', replicaStatus);
  console.log('Redis:', redisStatus);
  
  if (primaryStatus.status !== 'connected') {
    console.error('Cannot connect to primary database - exiting');
    process.exit(1);
  }
  
  if (replicaStatus.status !== 'connected') {
    console.error('Cannot connect to replica database - exiting');
    process.exit(1);
  }
  
  // Initial sync
  await runSyncCycle();
  
  // Schedule regular syncing
  setInterval(runSyncCycle, 60000); // Every minute
  setInterval(runCleanupCycle, 3600000); // Every hour
  
  console.log('DLUX Presence Sync Service running');
  console.log('- Sync cycle: every 60 seconds');
  console.log('- Cleanup cycle: every hour');
}

// Error handling
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully');
  await primaryPool.end();
  await replicaPool.end();
  await redis.quit();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down gracefully');
  await primaryPool.end();
  await replicaPool.end();
  await redis.quit();
  process.exit(0);
});

// Start the service
startup().catch(console.error); 