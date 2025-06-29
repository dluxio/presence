const express = require('express');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');
const { Pool } = require('pg');
const Redis = require('redis');
const crypto = require('crypto');
const fetch = require('node-fetch');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: ['https://dlux.io', 'https://vue.dlux.io', 'https://data.dlux.io'],
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// Database connections (READ-ONLY replica)
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

// Configuration for data.dlux.io API
const DATA_API_URL = process.env.DATA_API_URL || 'https://data.dlux.io';

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
// CORE API ENDPOINTS (READ-ONLY)
// ==================================================================

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'dlux-presence-read-replica',
    timestamp: new Date().toISOString(),
    version: '2.1.0'
  });
});

// Database connection test endpoint (read-only)
app.get('/api/test-connections', async (req, res) => {
  const results = {
    timestamp: new Date().toISOString(),
    replica_db: { status: 'error', error: 'Not tested' },
    redis: { status: 'error', error: 'Not tested' },
    data_api: { status: 'error', error: 'Not tested' }
  };

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

  // Test Data API
  try {
    const response = await fetch(`${DATA_API_URL}/api/presence/health`);
    if (response.ok) {
      results.data_api = { status: 'connected', timestamp: new Date().toISOString() };
    } else {
      results.data_api = { status: 'error', error: `HTTP ${response.status}` };
    }
  } catch (error) {
    results.data_api = { status: 'error', error: error.message };
  }

  const allConnected = results.replica_db.status === 'connected' && 
                       results.redis.status === 'connected' &&
                       results.data_api.status === 'connected';

  res.status(allConnected ? 200 : 500).json(results);
});

// TURN server configuration endpoint for WebRTC clients
app.get('/api/webrtc/turn-config', authenticateOptional, (req, res) => {
  try {
    const turnConfig = generateTurnCredentials(req.user?.account);
    
    res.json({
      iceServers: [
        {
          urls: [
            'stun:presence.dlux.io:3478',
            'turn:presence.dlux.io:3478?transport=udp',
            'turn:presence.dlux.io:3478?transport=tcp'
          ],
          username: turnConfig.username,
          credential: turnConfig.password
        }
      ],
      iceTransportPolicy: 'all',
      iceCandidatePoolSize: 10
    });
    
  } catch (error) {
    console.error('Error generating TURN config:', error);
    res.status(500).json({ error: 'Failed to generate TURN configuration' });
  }
});

// Serve TURN test page
app.get('/test-turn', (req, res) => {
  res.sendFile(__dirname + '/../test-turn.html');
});

// ==================================================================
// VR SPACE MANAGEMENT (READ-ONLY)
// ==================================================================

// Get available VR spaces (read from replica)
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
    
    // Add collaboration documents if table exists
    try {
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
    } catch (error) {
      // Table might not exist in replica - skip
      console.log('Collaboration documents table not available in replica');
    }
    
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
      try {
        const activeQuery = `
          SELECT COUNT(*) as count
          FROM presence_sessions 
          WHERE space_type = $1 AND space_id = $2 
            AND last_activity > NOW() - INTERVAL '5 minutes'
        `;
        const activeResult = await replicaPool.query(activeQuery, [space.space_type, space.space_id]);
        space.active_users = parseInt(activeResult.rows[0].count) || 0;
      } catch (error) {
        space.active_users = 0; // Table might not exist in replica
      }
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

// Get space details (read from replica)
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
      try {
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
      } catch (error) {
        console.log('Document tables not available in replica');
        hasAccess = false;
      }
      
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
    
    // Get active users (if table exists)
    let sessionData = { active_users: 0, users: [] };
    try {
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
      sessionData = sessionsResult.rows[0];
    } catch (error) {
      console.log('Presence sessions table not available in replica');
    }
    
    // Get space settings (if table exists)
    let settings = {
      settings: {},
      chat_enabled: true,
      voice_enabled: true,
      max_users: 50
    };
    
    try {
      const settingsQuery = `
        SELECT settings, chat_enabled, voice_enabled, max_users
        FROM presence_space_settings
        WHERE space_type = $1 AND space_id = $2
      `;
      
      const settingsResult = await replicaPool.query(settingsQuery, [spaceType, spaceId]);
      if (settingsResult.rows.length > 0) {
        settings = settingsResult.rows[0];
      }
    } catch (error) {
      console.log('Space settings table not available in replica');
    }
    
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

// Join VR space (simplified - just check access, no writes)
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
// CHAT AND MESSAGING API (READ-ONLY)
// ==================================================================

// Get chat messages for a space (read from replica)
app.get('/api/chat/:spaceType/:spaceId/messages', authenticateOptional, async (req, res) => {
  try {
    const { spaceType, spaceId } = req.params;
    const { limit = 50, offset = 0, subspace = 'main' } = req.query;
    
    try {
      const query = `
        SELECT m.*, 
               COALESCE(m.user_account, 'Guest-' || m.guest_id) as display_name
        FROM chat_messages m
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
      console.log('Chat messages table not available in replica');
      res.json({
        messages: [],
        has_more: false,
        node: 'presence.dlux.io'
      });
    }
    
  } catch (error) {
    console.error('Error getting chat messages:', error);
    res.status(500).json({ error: 'Failed to get messages' });
  }
});

  // Send chat message (proxy to data API)
  app.post('/api/chat/:spaceType/:spaceId/messages', authenticateOptional, async (req, res) => {
    try {
      const { spaceType, spaceId } = req.params;
      const { content, subspace = 'main', message_type = 'text', parent_message_id = null } = req.body;
      const userAccount = req.user?.account || null;
      const guestId = userAccount ? null : generateGuestId(req);
    
    if (!content || content.length > 2000) {
      return res.status(400).json({ error: 'Invalid message content' });
    }
    
    // Make API call to data.dlux.io
    const response = await fetch(`${DATA_API_URL}/api/presence/chat/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': req.get('User-Agent') || 'presence-api',
        'X-Forwarded-For': req.ip
      },
      body: JSON.stringify({
        space_type: spaceType,
        space_id: spaceId,
        subspace,
        user_account: userAccount,
        guest_id: guestId,
        message_type,
        content,
        parent_message_id
      })
    });
    
    if (!response.ok) {
      throw new Error(`Data API error: ${response.status}`);
    }
    
    const result = await response.json();
    const message = result.message;
    
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
      
      // Store session in main database via API call
      try {
        await fetch(`${DATA_API_URL}/api/presence/sessions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            socket_id: socket.id,
            user_account: userAccount,
            space_type: spaceType,
            space_id: spaceId,
            subspace,
            position,
            avatar_data,
            voice_enabled: false
          })
        });

        // Log activity
        await fetch(`${DATA_API_URL}/api/presence/activity`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            space_type: spaceType,
            space_id: spaceId,
            user_account: userAccount,
            activity_type: 'join',
            activity_data: { subspace, timestamp: Date.now() }
          })
        });
        
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

  // Real-time chat messaging (proxy to data API)
  socket.on('chat-message', async (data) => {
    if (currentSession) {
      try {
        const { content, message_type = 'text', parent_message_id = null } = data;
        const userAccount = currentSession.userAccount;
        const guestId = userAccount ? null : generateGuestId({ ip: socket.handshake.address });
        
        if (!content || content.length > 2000) {
          socket.emit('chat-error', { error: 'Invalid message content' });
          return;
        }
        
        // Send to data API
        const response = await fetch(`${DATA_API_URL}/api/presence/chat/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            space_type: currentSession.spaceType,
            space_id: currentSession.spaceId,
            subspace: currentSession.subspace,
            user_account: userAccount,
            guest_id: guestId,
            message_type,
            content,
            parent_message_id
          })
        });
        
        if (!response.ok) {
          throw new Error(`Data API error: ${response.status}`);
        }
        
        const result = await response.json();
        const message = result.message;
        
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
      // Update activity timestamp via API
      try {
        await fetch(`${DATA_API_URL}/api/presence/sessions/${socket.id}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            position: data.position || {},
            voice_enabled: data.voice_enabled || false
          })
        });
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
  const ip = req.ip || req.connection?.remoteAddress || req.handshake?.address || 'unknown';
  const userAgent = req.get?.('User-Agent') || req.headers?.['user-agent'] || '';
  return crypto.createHash('md5').update(ip + userAgent + Date.now()).digest('hex').slice(0, 8);
}

async function verifyHiveSignature(signature) {
  // Implementation would verify Hive signature
  // For now, return null to indicate guest access
  return null;
}

async function getUsersInSpace(roomName) {
  try {
    const sockets = await io.in(roomName).fetchSockets();
    return sockets.map(socketClient => ({
      socketId: socketClient.id,
      userAccount: null, // Would be populated from session data
      connected_at: new Date()
    }));
  } catch (error) {
    console.error('Error getting users in space:', error);
    return [];
  }
}

async function cleanupSession(socketId) {
  try {
    await fetch(`${DATA_API_URL}/api/presence/sessions/${socketId}`, {
      method: 'DELETE'
    });
  } catch (error) {
    console.error('Error cleaning up session:', error);
  }
}

// Start server
const PORT = process.env.PORT || 3000;
let isShuttingDown = false;

server.listen(PORT, () => {
  console.log(`DLUX Presence Read-Only API running on port ${PORT}`);
  console.log(`Data API: ${DATA_API_URL}`);
  console.log(`Replica DB: ${process.env.DB_REPLICA_HOST || 'db_replica'}`);
  console.log(`Redis: ${process.env.REDIS_HOST || 'redis'}`);
});

async function gracefulShutdown(signal) {
  if (isShuttingDown) {
    console.log('Shutdown already in progress...');
    return;
  }
  
  isShuttingDown = true;
  console.log(`${signal} received, shutting down gracefully...`);
  
  const forceExitTimeout = setTimeout(() => {
    console.error('Forced shutdown after 10 seconds');
    process.exit(1);
  }, 10000);
  
  try {
    // Close HTTP server first
    await new Promise((resolve, reject) => {
      server.close((err) => {
        if (err) {
          console.error('Error closing HTTP server:', err);
          reject(err);
        } else {
          console.log('HTTP server closed');
          resolve();
        }
      });
    });
    
    // Close Socket.IO
    io.close(() => {
      console.log('Socket.IO server closed');
    });
    
    // Close database connections
    try {
      await replicaPool.end();
      console.log('Replica database connection closed');
    } catch (error) {
      console.error('Error closing replica database:', error.message);
    }
    
    // Close Redis connection
    try {
      if (redis && typeof redis.quit === 'function') {
        await redis.quit();
        console.log('Redis connection closed');
      }
    } catch (error) {
      console.error('Error closing Redis connection:', error.message);
    }
    
    clearTimeout(forceExitTimeout);
    console.log('Graceful shutdown completed');
    process.exit(0);
    
  } catch (error) {
    console.error('Error during graceful shutdown:', error);
    clearTimeout(forceExitTimeout);
    process.exit(1);
  }
}

// Graceful shutdown signal handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGUSR2', () => gracefulShutdown('SIGUSR2')); // For nodemon compatibility

// Error handling
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  if (!isShuttingDown) {
    gracefulShutdown('UNCAUGHT_EXCEPTION').catch(() => process.exit(1));
  }
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

module.exports = { app, server, io }; 