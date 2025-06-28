const express = require('express');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');
const { Pool } = require('pg');
const Redis = require('redis');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: ['https://dlux.io', 'https://vue.dlux.io', 'https://data.dlux.io'],
    methods: ['GET', 'POST'],
    credentials: true
  }
});

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
  ssl: false // Local replica
});

// Redis connection
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

// Middleware
app.use(cors({
  origin: ['https://dlux.io', 'https://vue.dlux.io', 'https://data.dlux.io'],
  credentials: true
}));
app.use(express.json());

// Authentication middleware
const authenticateOptional = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const signature = authHeader.slice(7);
    try {
      const user = await verifyHiveSignature(signature);
      req.user = user;
    } catch (error) {
      // Optional auth - continue even if verification fails
    }
  }
  next();
};

// ==================================================================
// CORE API ENDPOINTS
// ==================================================================

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'dlux-presence-enhanced',
    timestamp: new Date().toISOString(),
    version: '2.0.0'
  });
});

// Database and Redis connection test endpoint
app.get('/api/test-connections', async (req, res) => {
  const results = {
    timestamp: new Date().toISOString(),
    primary_db: { status: 'error', error: 'Not tested' },
    replica_db: { status: 'error', error: 'Not tested' },
    redis: { status: 'error', error: 'Not tested' }
  };

  // Test Primary Database
  try {
    await primaryPool.query('SELECT 1');
    results.primary_db = { status: 'connected', timestamp: new Date().toISOString() };
  } catch (error) {
    results.primary_db = { status: 'error', error: error.message };
  }

  // Test Replica Database
  try {
    await replicaPool.query('SELECT 1');
    results.replica_db = { status: 'connected', timestamp: new Date().toISOString() };
  } catch (error) {
    results.replica_db = { status: 'error', error: error.message };
  }

  // Test Redis
  try {
    await redis.ping();
    results.redis = { status: 'connected', timestamp: new Date().toISOString() };
  } catch (error) {
    results.redis = { status: 'error', error: error.message };
  }

  const allConnected = results.primary_db.status === 'connected' && 
                       results.replica_db.status === 'connected' && 
                       results.redis.status === 'connected';

  res.status(allConnected ? 200 : 500).json(results);
});

// ==================================================================
// VR SPACE MANAGEMENT
// ==================================================================

// Get available VR spaces (autonomous - no data.dlux.io dependency)
app.get('/api/spaces', authenticateOptional, async (req, res) => {
  try {
    const { limit = 20, offset = 0, type = null } = req.query;
    const userAccount = req.user?.account || null;
    
    // Get from local replica
    let query = `
      SELECT 'post' as space_type, 
             CONCAT(author, '/', permlink) as space_id,
             author || ': ' || COALESCE(title, permlink) as display_name,
             COALESCE(title, 'Post: ' || LEFT(permlink, 50)) as description,
             type,
             votes,
             rating,
             created_at
      FROM posts 
      WHERE type IN ('360', 'vrml', 'aframe', 'blog', 'art', 'game')
        AND NOT hidden AND NOT flagged
    `;
    
    if (type && type !== 'all') {
      query += ` AND type = $3`;
    }
    
    query += ` ORDER BY created_at DESC LIMIT $1 OFFSET $2`;
    
    const params = [limit, offset];
    if (type && type !== 'all') params.push(type);
    
    const postsResult = await replicaPool.query(query, params);
    const spaces = [...postsResult.rows];
    
    // Add collaboration documents
    const docsQuery = `
      SELECT 'document' as space_type,
             id::text as space_id,
             title as display_name,
             'Collaborative Document' as description,
             'document' as type,
             0 as votes,
             0 as rating,
             created_at
      FROM collaboration_documents
      WHERE is_public = true ${userAccount ? 'OR creator = $3' : ''}
      ORDER BY updated_at DESC
      LIMIT $1 OFFSET $2
    `;
    
    const docParams = [limit, offset];
    if (userAccount) docParams.push(userAccount);
    
    const docsResult = await replicaPool.query(docsQuery, docParams);
    spaces.push(...docsResult.rows);
    
    // Add global lobby
    spaces.unshift({
      space_type: 'global',
      space_id: 'lobby',
      display_name: 'Global Lobby',
      description: 'Main social VR space for all users',
      type: 'lobby',
      votes: 0,
      rating: 0,
      created_at: new Date()
    });
    
    // Get active user counts for each space
    for (const space of spaces) {
      const activeQuery = `
        SELECT COUNT(*) as count
        FROM presence_sessions 
        WHERE space_type = $1 AND space_id = $2 
          AND last_activity > NOW() - INTERVAL '5 minutes'
      `;
      const activeResult = await replicaPool.query(activeQuery, [space.space_type, space.space_id]);
      space.active_users = parseInt(activeResult.rows[0].count) || 0;
    }
    
    res.json({
      spaces,
      total: spaces.length,
      node: 'presence.dlux.io'
    });
    
  } catch (error) {
    console.error('Error getting spaces:', error);
    res.status(500).json({ error: 'Failed to get spaces' });
  }
});

// Get space details (autonomous)
app.get('/api/spaces/:spaceType/:spaceId', authenticateOptional, async (req, res) => {
  try {
    const { spaceType, spaceId } = req.params;
    const userAccount = req.user?.account || null;
    
    let spaceData = null;
    let hasAccess = false;
    
    if (spaceType === 'post') {
      const [author, permlink] = spaceId.split('/');
      const query = `
        SELECT author, permlink, type, votes, rating, nsfw, 
               title, content, created_at, updated_at
        FROM posts 
        WHERE author = $1 AND permlink = $2
          AND NOT hidden AND NOT flagged
      `;
      const result = await replicaPool.query(query, [author, permlink]);
      spaceData = result.rows[0];
      hasAccess = !!spaceData; // Public access for posts
      
    } else if (spaceType === 'document') {
      const query = `
        SELECT d.*, 
               CASE WHEN d.is_public = true OR d.creator = $2 THEN true
                    WHEN p.permission IS NOT NULL THEN true
                    ELSE false END as has_access
        FROM collaboration_documents d
        LEFT JOIN collaboration_permissions p ON d.id = p.document_id AND p.user_account = $2
        WHERE d.id = $1
      `;
      const result = await replicaPool.query(query, [spaceId, userAccount]);
      spaceData = result.rows[0];
      hasAccess = spaceData?.has_access || false;
      
    } else if (spaceType === 'global' && spaceId === 'lobby') {
      spaceData = {
        space_id: 'lobby',
        title: 'Global Lobby',
        description: 'Welcome to DLUX Presence VR',
        type: 'lobby',
        is_public: true
      };
      hasAccess = true;
    }
    
    if (!spaceData || !hasAccess) {
      return res.status(404).json({ error: 'Space not found or access denied' });
    }
    
    // Get active users
    const sessionsQuery = `
      SELECT COUNT(*) as active_users,
             JSON_AGG(
               JSON_BUILD_OBJECT(
                 'socket_id', socket_id,
                 'user_account', user_account,
                 'connected_at', connected_at,
                 'position', position,
                 'voice_enabled', voice_enabled
               )
             ) FILTER (WHERE socket_id IS NOT NULL) as users
      FROM presence_sessions 
      WHERE space_type = $1 AND space_id = $2 
        AND last_activity > NOW() - INTERVAL '5 minutes'
    `;
    
    const sessionsResult = await replicaPool.query(sessionsQuery, [spaceType, spaceId]);
    const sessionData = sessionsResult.rows[0];
    
    // Get space settings
    const settingsQuery = `
      SELECT settings, chat_enabled, voice_enabled, max_users
      FROM presence_space_settings
      WHERE space_type = $1 AND space_id = $2
    `;
    
    const settingsResult = await replicaPool.query(settingsQuery, [spaceType, spaceId]);
    const settings = settingsResult.rows[0] || {
      settings: {},
      chat_enabled: true,
      voice_enabled: true,
      max_users: 50
    };
    
    res.json({
      space: {
        ...spaceData,
        space_type: spaceType,
        space_id: spaceId,
        active_users: parseInt(sessionData.active_users) || 0,
        connected_users: sessionData.users || [],
        ...settings
      },
      has_access: hasAccess,
      node: 'presence.dlux.io'
    });
    
  } catch (error) {
    console.error('Error getting space details:', error);
    res.status(500).json({ error: 'Failed to get space details' });
  }
});

// Join VR space (autonomous authorization)
app.post('/api/spaces/:spaceType/:spaceId/join', authenticateOptional, async (req, res) => {
  try {
    const { spaceType, spaceId } = req.params;
    const { subspace = 'main' } = req.body;
    const userAccount = req.user?.account || null;
    
    // Check if space exists and user has access
    const spaceCheck = await fetch(`${req.protocol}://${req.get('host')}/api/spaces/${spaceType}/${spaceId}`, {
      headers: req.headers
    });
    
    if (!spaceCheck.ok) {
      return res.status(403).json({ error: 'Space not accessible' });
    }
    
    const spaceData = await spaceCheck.json();
    
    // Check max users
    if (spaceData.space.active_users >= spaceData.space.max_users) {
      return res.status(429).json({ error: 'Space is full' });
    }
    
    // Generate TURN credentials
    const turnCredentials = generateTurnCredentials(userAccount);
    
    res.json({
      success: true,
      space: spaceData.space,
      subspace,
      turn_credentials: turnCredentials,
      websocket_url: `wss://${req.get('host')}/socket.io/`,
      node: 'presence.dlux.io'
    });
    
  } catch (error) {
    console.error('Error joining space:', error);
    res.status(500).json({ error: 'Failed to join space' });
  }
});

// ==================================================================
// CHAT AND MESSAGING API
// ==================================================================

// Get chat messages for a space
app.get('/api/chat/:spaceType/:spaceId/messages', authenticateOptional, async (req, res) => {
  try {
    const { spaceType, spaceId } = req.params;
    const { limit = 50, offset = 0, subspace = 'main' } = req.query;
    
    const query = `
      SELECT m.*, 
             COALESCE(u.display_name, m.user_account) as display_name,
             r.reactions
      FROM chat_messages m
      LEFT JOIN users u ON m.user_account = u.account
      LEFT JOIN (
        SELECT message_id, JSON_AGG(
          JSON_BUILD_OBJECT('reaction', reaction, 'count', count)
        ) as reactions
        FROM (
          SELECT message_id, reaction, COUNT(*) as count
          FROM message_reactions
          GROUP BY message_id, reaction
        ) grouped_reactions
        GROUP BY message_id
      ) r ON m.id = r.message_id
      WHERE m.space_type = $1 AND m.space_id = $2 AND m.subspace = $3
        AND NOT m.is_deleted
      ORDER BY m.created_at DESC
      LIMIT $4 OFFSET $5
    `;
    
    const result = await replicaPool.query(query, [spaceType, spaceId, subspace, limit, offset]);
    
    res.json({
      messages: result.rows.reverse(), // Reverse to get chronological order
      has_more: result.rows.length === parseInt(limit),
      node: 'presence.dlux.io'
    });
    
  } catch (error) {
    console.error('Error getting chat messages:', error);
    res.status(500).json({ error: 'Failed to get messages' });
  }
});

// Send chat message
app.post('/api/chat/:spaceType/:spaceId/messages', authenticateOptional, async (req, res) => {
  try {
    const { spaceType, spaceId } = req.params;
    const { content, subspace = 'main', message_type = 'text', parent_message_id = null } = req.body;
    const userAccount = req.user?.account || null;
    const guestId = userAccount ? null : generateGuestId(req);
    
    if (!content || content.length > 2000) {
      return res.status(400).json({ error: 'Invalid message content' });
    }
    
    const query = `
      INSERT INTO chat_messages 
      (space_type, space_id, subspace, user_account, guest_id, message_type, content, parent_message_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `;
    
    const result = await replicaPool.query(query, [
      spaceType, spaceId, subspace, userAccount, guestId, message_type, content, parent_message_id
    ]);
    
    const message = result.rows[0];
    
    // Broadcast to connected users
    const roomName = `${spaceType}:${spaceId}:${subspace}`;
    io.to(roomName).emit('chat-message', {
      ...message,
      display_name: userAccount || `Guest-${guestId}`
    });
    
    res.json({
      message,
      node: 'presence.dlux.io'
    });
    
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// ==================================================================
// DOCUMENT COLLABORATION API
// ==================================================================

// Get document comments
app.get('/api/documents/:documentId/comments', authenticateOptional, async (req, res) => {
  try {
    const { documentId } = req.params;
    const { limit = 100, offset = 0 } = req.query;
    
    const query = `
      SELECT c.*, 
             COALESCE(u.display_name, c.user_account) as display_name
      FROM document_comments c
      LEFT JOIN users u ON c.user_account = u.account
      WHERE c.document_id = $1 AND NOT c.is_deleted
      ORDER BY c.created_at ASC
      LIMIT $2 OFFSET $3
    `;
    
    const result = await replicaPool.query(query, [documentId, limit, offset]);
    
    res.json({
      comments: result.rows,
      node: 'presence.dlux.io'
    });
    
  } catch (error) {
    console.error('Error getting document comments:', error);
    res.status(500).json({ error: 'Failed to get comments' });
  }
});

// Add document comment
app.post('/api/documents/:documentId/comments', authenticateOptional, async (req, res) => {
  try {
    const { documentId } = req.params;
    const { 
      content, 
      comment_type = 'comment', 
      document_section = null,
      position_data = null,
      parent_comment_id = null 
    } = req.body;
    const userAccount = req.user?.account || null;
    
    if (!userAccount) {
      return res.status(401).json({ error: 'Authentication required for comments' });
    }
    
    const query = `
      INSERT INTO document_comments 
      (document_id, user_account, content, comment_type, document_section, position_data, parent_comment_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `;
    
    const result = await replicaPool.query(query, [
      documentId, userAccount, content, comment_type, document_section, 
      position_data ? JSON.stringify(position_data) : null, parent_comment_id
    ]);
    
    const comment = result.rows[0];
    
    // Broadcast to document collaborators
    io.to(`document:${documentId}`).emit('document-comment', comment);
    
    res.json({
      comment,
      node: 'presence.dlux.io'
    });
    
  } catch (error) {
    console.error('Error adding comment:', error);
    res.status(500).json({ error: 'Failed to add comment' });
  }
});

// ==================================================================
// SOCKET.IO REAL-TIME HANDLERS
// ==================================================================

io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id}`);
  
  let currentSession = null;

  // Join content-based VR space
  socket.on('join-space', async (data) => {
    try {
      const { spaceType, spaceId, subspace = 'main', userAccount = null, position = null, avatar_data = null } = data;
      
      console.log(`User ${userAccount || 'guest'} joining ${spaceType}/${spaceId}/${subspace}`);
      
      // Leave previous space if connected
      if (currentSession) {
        socket.leave(currentSession.roomName);
        await cleanupSession(socket.id);
        
        // Notify previous room
        socket.to(currentSession.roomName).emit('user-left', {
          socketId: socket.id,
          userAccount: currentSession.userAccount,
          timestamp: Date.now()
        });
      }
      
      // Create new session
      const roomName = `${spaceType}:${spaceId}:${subspace}`;
      currentSession = {
        spaceType,
        spaceId,
        subspace,
        userAccount,
        roomName
      };
      
      // Join Socket.IO room
      socket.join(roomName);
      
      // Store session in database
      try {
        await replicaPool.query(`
          INSERT INTO presence_sessions 
          (socket_id, user_account, space_type, space_id, subspace, position, avatar_data, connected_at, last_activity)
          VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
          ON CONFLICT (socket_id) DO UPDATE SET
            user_account = $2, space_type = $3, space_id = $4, 
            subspace = $5, position = $6, avatar_data = $7, last_activity = NOW()
        `, [socket.id, userAccount, spaceType, spaceId, subspace, 
           position ? JSON.stringify(position) : null,
           avatar_data ? JSON.stringify(avatar_data) : null]);

        // Log activity
        await replicaPool.query(`
          INSERT INTO space_activity (space_type, space_id, user_account, activity_type, activity_data)
          VALUES ($1, $2, $3, 'join', $4)
        `, [spaceType, spaceId, userAccount, JSON.stringify({ subspace, timestamp: Date.now() })]);
        
      } catch (dbError) {
        console.error('Database session error:', dbError);
        // Continue even if DB fails - core functionality works
      }
      
      // Get current users in space
      const users = await getUsersInSpace(roomName);
      
      // Notify space of new user
      socket.to(roomName).emit('user-joined', { 
        socketId: socket.id, 
        userAccount,
        position,
        avatar_data,
        timestamp: Date.now()
      });
      
      // Send current space state to new user
      socket.emit('space-joined', {
        success: true,
        spaceType,
        spaceId,
        subspace,
        users,
        timestamp: Date.now()
      });
      
      // Join chat subscription
      socket.join(`chat:${roomName}`);
      
      console.log(`User ${userAccount || 'guest'} joined space ${roomName}`);
      
    } catch (error) {
      console.error('Error joining space:', error);
      socket.emit('space-error', { error: 'Failed to join space' });
    }
  });

  // Real-time chat messaging
  socket.on('chat-message', async (data) => {
    if (currentSession) {
      try {
        const { content, message_type = 'text', parent_message_id = null } = data;
        const userAccount = currentSession.userAccount;
        const guestId = userAccount ? null : generateGuestId(req);
        
        if (!content || content.length > 2000) {
          socket.emit('chat-error', { error: 'Invalid message content' });
          return;
        }
        
        // Insert message into database
        const result = await replicaPool.query(`
          INSERT INTO chat_messages 
          (space_type, space_id, subspace, user_account, guest_id, message_type, content, parent_message_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          RETURNING *
        `, [
          currentSession.spaceType, currentSession.spaceId, currentSession.subspace,
          userAccount, guestId, message_type, content, parent_message_id
        ]);
        
        const message = result.rows[0];
        
        // Broadcast to all users in space
        io.to(`chat:${currentSession.roomName}`).emit('chat-message', {
          ...message,
          display_name: userAccount || `Guest-${guestId}`,
          timestamp: Date.now()
        });
        
      } catch (error) {
        console.error('Error sending chat message:', error);
        socket.emit('chat-error', { error: 'Failed to send message' });
      }
    }
  });

  // WebRTC signaling for voice chat
  socket.on('webrtc-offer', (data) => {
    if (currentSession) {
      socket.to(data.targetSocketId).emit('webrtc-offer', {
        offer: data.offer,
        fromSocketId: socket.id,
        fromUser: currentSession.userAccount
      });
    }
  });

  socket.on('webrtc-answer', (data) => {
    if (currentSession) {
      socket.to(data.targetSocketId).emit('webrtc-answer', {
        answer: data.answer,
        fromSocketId: socket.id,
        fromUser: currentSession.userAccount
      });
    }
  });

  socket.on('webrtc-ice-candidate', (data) => {
    if (currentSession) {
      socket.to(data.targetSocketId).emit('webrtc-ice-candidate', {
        candidate: data.candidate,
        fromSocketId: socket.id
      });
    }
  });

  // A-Frame entity synchronization for VR interactions
  socket.on('aframe-update', async (data) => {
    if (currentSession) {
      // Update activity timestamp and position
      try {
        await replicaPool.query(`
          UPDATE presence_sessions 
          SET last_activity = NOW(), position = $2
          WHERE socket_id = $1
        `, [socket.id, JSON.stringify(data.position || {})]);
      } catch (error) {
        console.error('Error updating position:', error);
      }
      
      // Broadcast entity update to others in space
      socket.to(currentSession.roomName).emit('aframe-update', {
        socketId: socket.id,
        userAccount: currentSession.userAccount,
        entityData: data,
        timestamp: Date.now()
      });
    }
  });

  // Handle disconnection
  socket.on('disconnect', async () => {
    console.log(`Socket disconnected: ${socket.id}`);
    
    if (currentSession) {
      const { roomName, userAccount, spaceType, spaceId } = currentSession;
      
      socket.to(roomName).emit('user-left', { 
        socketId: socket.id, 
        userAccount,
        timestamp: Date.now()
      });
    }
    
    await cleanupSession(socket.id);
  });
});

// ==================================================================
// UTILITY FUNCTIONS
// ==================================================================

function generateTurnCredentials(username = null) {
  const secret = process.env.TURN_SECRET || 'default_secret';
  const ttl = 3600; // 1 hour
  
  const timestamp = Math.floor(Date.now() / 1000) + ttl;
  const turnUsername = username ? `${timestamp}:${username}` : `${timestamp}:temp`;
  
  const hmac = crypto.createHmac('sha1', secret);
  hmac.update(turnUsername);
  const turnPassword = hmac.digest('base64');
  
  return {
    username: turnUsername,
    password: turnPassword,
    ttl: ttl,
    uris: [
      'stun:presence.dlux.io:3478',
      'turn:presence.dlux.io:3478?transport=udp',
      'turn:presence.dlux.io:3478?transport=tcp',
      'turns:presence.dlux.io:5349?transport=tcp'
    ]
  };
}

function generateGuestId(req) {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const userAgent = req.get?.('User-Agent') || req.headers?.['user-agent'] || '';
  return crypto.createHash('md5').update(ip + userAgent).digest('hex').slice(0, 8);
}

async function verifyHiveSignature(signature) {
  // Implementation would verify Hive signature
  // For now, return null to indicate guest access
  return null;
}

async function getUsersInSpace(roomName) {
  try {
    const sockets = await io.in(roomName).fetchSockets();
    const users = [];
    
    for (const socketClient of sockets) {
      // Get user session data from database
      try {
        const result = await replicaPool.query(`
          SELECT user_account, position, avatar_data, voice_enabled, connected_at
          FROM presence_sessions
          WHERE socket_id = $1
        `, [socketClient.id]);
        
        if (result.rows.length > 0) {
          const session = result.rows[0];
          users.push({
            socketId: socketClient.id,
            userAccount: session.user_account,
            position: session.position,
            avatar_data: session.avatar_data,
            voice_enabled: session.voice_enabled,
            connected_at: session.connected_at
          });
        }
      } catch (error) {
        console.error('Error getting user session:', error);
        // Fallback to basic socket info
        users.push({
          socketId: socketClient.id,
          userAccount: null
        });
      }
    }
    
    return users;
  } catch (error) {
    console.error('Error getting users in space:', error);
    return [];
  }
}

async function cleanupSession(socketId) {
  try {
    await replicaPool.query('DELETE FROM presence_sessions WHERE socket_id = $1', [socketId]);
  } catch (error) {
    console.error('Error cleaning up session:', error);
  }
}

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`DLUX Presence Enhanced API running on port ${PORT}`);
  console.log(`Primary DB: ${process.env.DB_PRIMARY_HOST || 'data.dlux.io'}`);
  console.log(`Replica DB: ${process.env.DB_REPLICA_HOST || 'db_replica'}`);
  console.log(`Redis: ${process.env.REDIS_HOST || 'redis'}`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(async () => {
    await primaryPool.end();
    await replicaPool.end();
    await redis.quit();
    process.exit(0);
  });
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down gracefully');
  server.close(async () => {
    await primaryPool.end();
    await replicaPool.end();
    await redis.quit();
    process.exit(0);
  });
});

module.exports = { app, server, io }; 