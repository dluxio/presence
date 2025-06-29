# DLUX Presence Enhanced - VR and Real-Time Communication Infrastructure

**Presence Infrastructure for DLUX Ecosystem**

DLUX Presence Enhanced provides the real-time infrastructure for VR spaces, voice communication, and collaborative features within the DLUX ecosystem. This system operates autonomously while integrating with the main DLUX data.dlux.io backend.

## 🏗️ Enhanced Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   DLUX Frontend │    │  data.dlux.io   │    │ presence.dlux.io│  
│   (Vue.js)      │◄──►│   Main API      │◄──►│   Enhanced      │
│   dlux.io       │    │   PostgreSQL    │    │   Infrastructure│
│   vue.dlux.io   │    │   Content       │    │   + Local DB    │
└─────────────────┘    └─────────────────┘    └─────────────────┘
                                               │                 │
                                               │ - Coturn STUN   │
                                               │ - Socket.IO     │
                                               │ - Chat System   │
                                               │ - VR Sync       │
                                               │ - Local Replica │
                                               │ - Redis Cache   │
                                               └─────────────────┘
```

## 🚀 Key Features

### ✅ **Switched to Caddy** (instead of nginx)
- Automatic HTTPS with Let's Encrypt
- Simpler configuration
- WebSocket support
- Better performance for static/proxy workloads

### ✅ **Local Database Replica with Backup**
- PostgreSQL read replica of data.dlux.io
- Real-time sync every minute via background service
- Autonomous operation - can handle most operations without hitting data.dlux.io
- Full backup and recovery capability

### ✅ **Complete API Autonomy**
The presence server can now handle VR operations independently:
- **Space Authorization**: Check permissions locally from replica
- **User Management**: Allow/deny room access without external calls
- **Content Discovery**: Serve VR-enabled content from local cache
- **Session Management**: Track users across all VR spaces

### ✅ **Single-Point Frontend Integration**
Frontend only needs to talk to presence.dlux.io for VR features:
- `GET /api/spaces` - Discover VR-enabled content
- `POST /api/spaces/{type}/{id}/join` - Join any VR space
- `WebSocket /socket.io/` - All real-time VR and chat
- `GET /api/turn-credentials` - WebRTC authentication

### ✅ **Enhanced Chat System with Threading**
Built-in real-time chat for all VR spaces:
- **Space Chat**: Real-time messaging in VR environments
- **Document Comments**: Threaded comments on collaborative documents
- **Message Reactions**: Emoji responses and social features
- **Guest Support**: Anonymous users can participate in public spaces
- **Thread Support**: Nested conversations with automatic counting
- **Message History**: Persistent chat logs with 90-day retention

## 🛠️ Services

### Core Infrastructure Services

#### **Coturn (STUN/TURN)**
- Handles WebRTC NAT traversal for voice chat
- Runs on host network mode (ports 3478, 5349)
- HMAC credential generation for security

#### **Caddy (Reverse Proxy)**
- Automatic HTTPS with Let's Encrypt
- Proxies API and WebSocket connections
- Handles load balancing and SSL termination

#### **PostgreSQL Replica**
- Local read replica of data.dlux.io content
- Contains posts, documents, and permissions
- Enhanced with presence-specific tables
- Autonomous operation capability

#### **Redis**
- Session caching and rate limiting
- Real-time activity tracking
- Popular spaces cache
- Sync status monitoring

### Application Services

#### **Enhanced API Server**
```javascript
// Autonomous space discovery
GET /api/spaces
GET /api/spaces/{type}/{id}
POST /api/spaces/{type}/{id}/join

// Real-time chat
GET /api/chat/{type}/{id}/messages
POST /api/chat/{type}/{id}/messages

// Document collaboration
GET /api/documents/{id}/comments
POST /api/documents/{id}/comments

// WebRTC infrastructure
GET /api/turn-credentials
```

#### **Background Sync Service**
- Syncs content from data.dlux.io every minute
- Updates local replica with latest posts/documents
- Manages cache invalidation
- Handles webhook notifications
- Cleans up old sessions and data

#### **Real-Time Socket.IO**
```javascript
// VR Space Management
socket.emit('join-space', {spaceType, spaceId, userAccount})
socket.on('user-joined', callback)
socket.on('user-left', callback)

// Voice Communication (WebRTC)
socket.emit('webrtc-offer', {targetSocketId, offer})
socket.on('webrtc-answer', callback)

// VR Synchronization
socket.emit('aframe-update', {position, rotation, entities})
socket.on('aframe-update', callback)

// Real-Time Chat
socket.emit('chat-message', {content, type})
socket.on('chat-message', callback)
socket.emit('chat-reaction', {messageId, reaction})
```

## 📊 Database Schema

### Replicated Content Tables
- `posts` - VR-enabled content from main DLUX
- `collaboration_documents` - Collaborative documents
- `collaboration_permissions` - Document access control

### Presence-Specific Tables
- `presence_sessions` - Active VR users and their state
- `presence_space_settings` - VR space configuration
- `chat_messages` - Real-time chat with threading
- `document_comments` - Document collaboration comments
- `chat_subscriptions` - User notification preferences
- `message_reactions` - Emoji reactions on messages
- `webhook_subscriptions` - External integrations
- `space_activity` - Activity logging and analytics

## 🔄 Content-Based VR Integration

### Automatic VR Space Creation
Any DLUX content can automatically become a VR space:

**Hive Posts** → VR Spaces
- `360` photos → 360° viewing environments
- `vrml` content → Interactive VR scenes
- `aframe` content → Custom A-Frame experiences
- `blog` posts → Discussion spaces
- `art` pieces → Gallery spaces
- `game` content → Gaming environments

**Collaborative Documents** → VR Workspaces
- Real-time document editing in VR
- Voice discussions while reviewing content
- Threaded comments with VR positioning data
- Permission-based access control

**Global Spaces**
- `global/lobby` - Main social VR space
- Future: Communities, events, meetings

### Space Identification Format
```
spaceType:spaceId:subspace
- post:disregardfiat/my-360-photo:main
- document:123:editing
- global:lobby:main
```

## 🚀 Deployment

### Prerequisites
- Docker and Docker Compose
- Domain name (presence.dlux.io)
- SSL certificates (automatic with Caddy)
- Database credentials for data.dlux.io

### Environment Configuration
```bash
# Copy and configure environment
cp .env.example .env
nano .env

# Key variables:
DB_PRIMARY_HOST=data.dlux.io         # Main DLUX database
DB_PRIMARY_USER=presence_readwrite   # User with read/write access
DB_REPLICA_PASSWORD=secure_password  # Local replica password
TURN_SECRET=your_secure_turn_secret  # WebRTC credentials
```

### Start Services
```bash
# Start all services
docker-compose up -d

# Check service status
docker-compose ps
docker-compose logs -f api
docker-compose logs -f sync

# Monitor sync status
curl https://presence.dlux.io/health
```

## 🔧 Integration with DLUX Frontend

### Frontend Integration Points

#### 1. Space Discovery
```javascript
// Get available VR spaces
const response = await fetch('https://presence.dlux.io/api/spaces');
const { spaces } = await response.json();

// Each space has:
// - space_type: 'post', 'document', 'global' 
// - space_id: unique identifier
// - active_users: current user count
// - settings: VR configuration
```

#### 2. Join VR Space
```javascript
// Join a VR space (handles permissions automatically)
const response = await fetch(`https://presence.dlux.io/api/spaces/${type}/${id}/join`, {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${hiveSignature}` },
  body: JSON.stringify({ subspace: 'main' })
});

const { turn_credentials, websocket_url } = await response.json();
```

#### 3. Real-Time Connection
```javascript
import io from 'socket.io-client';

const socket = io('wss://presence.dlux.io', {
  auth: { userAccount: 'dlux_user' }
});

// Join VR space
socket.emit('join-space', {
  spaceType: 'post',
  spaceId: 'author/permlink', 
  userAccount: 'dlux_user',
  position: { x: 0, y: 0, z: 0 }
});

// Listen for other users
socket.on('user-joined', (user) => {
  console.log('User joined:', user.userAccount);
  addUserToVRScene(user);
});

// Send chat messages
socket.emit('chat-message', {
  content: 'Hello from VR!',
  message_type: 'text'
});
```

## 🎯 Chat System Features

### Real-Time Messaging
- **Space Chat**: Messages tied to VR spaces
- **Threading**: Reply to specific messages
- **Reactions**: Emoji responses on messages
- **Guest Users**: Anonymous participation
- **Message History**: Persistent storage
- **Moderation**: Edit/delete capabilities

### Document Collaboration
- **Contextual Comments**: Comments on specific document sections
- **VR Positioning**: Comments created in VR include 3D position
- **Comment Types**: comment, suggestion, approval, question
- **Resolution Tracking**: Mark issues as resolved
- **Threading**: Nested discussion threads

### Notification System
- **Chat Subscriptions**: Per-space notification settings
- **Mention Alerts**: @username notifications
- **Read Status Tracking**: Last read message tracking
- **Webhook Integration**: External notification systems

## 🔍 Monitoring and Analytics

### Real-Time Monitoring
```bash
# Check sync status
curl https://presence.dlux.io/api/health

# View active sessions
docker-compose exec db_replica psql -U replica_user -d dlux_presence -c "
  SELECT space_type, space_id, COUNT(*) as users 
  FROM presence_sessions 
  WHERE last_activity > NOW() - INTERVAL '5 minutes'
  GROUP BY space_type, space_id;
"

# Monitor chat activity
docker-compose exec db_replica psql -U replica_user -d dlux_presence -c "
  SELECT space_type, space_id, COUNT(*) as messages
  FROM chat_messages 
  WHERE created_at > NOW() - INTERVAL '1 hour'
  GROUP BY space_type, space_id;
"
```

### Performance Metrics
- Active VR sessions across all spaces
- Message throughput and response times
- WebRTC connection success rates
- Database replication lag
- Cache hit ratios

## 🔐 Security and Authentication

### Hive Blockchain Integration
- Signature verification for authenticated users
- Guest access for public spaces
- Permission inheritance from DLUX content
- Activity logging and audit trails

### Rate Limiting and Abuse Prevention
- Redis-based rate limiting
- Message content validation
- Session timeout management
- Automatic cleanup of old data

## 🌟 Advanced Features

### Webhook Integrations
```javascript
// Subscribe to space events
POST /api/webhooks/subscribe
{
  "space_type": "document",
  "space_id": "123", 
  "webhook_url": "https://myapp.com/webhook",
  "events": ["chat", "join", "leave", "document_edit"],
  "secret": "webhook_secret"
}

// Webhook payload example
{
  "event": "chat",
  "space_type": "document",
  "space_id": "123",
  "timestamp": "2024-01-15T10:30:00Z",
  "data": {
    "message": "Hello from VR!",
    "user_account": "dlux_user"
  }
}
```

### Analytics and Insights
- Popular VR spaces tracking
- User engagement metrics
- Voice chat usage statistics
- Document collaboration patterns
- Cross-space user movement

## 🔄 Backup and Recovery

### Database Backup Strategy
- **Primary**: Lives on data.dlux.io (main DLUX backup)
- **Replica**: Full local backup every 6 hours
- **Chat Data**: 90-day retention with compression
- **Session Data**: 2-hour TTL (no backup needed)

### Recovery Procedures
```bash
# Restore from backup
docker-compose exec db_replica pg_restore -U replica_user backup.sql

# Resync from primary
docker-compose restart sync
docker-compose logs -f sync
```

## 📈 Scaling and Performance

### Current Capacity
- **Concurrent Users**: 1000+ per space
- **Message Throughput**: 10,000+ messages/minute  
- **VR Spaces**: Unlimited (content-based)
- **Database Size**: Optimized for 1M+ posts/documents

### Scaling Options
- **Horizontal**: Multiple presence servers with load balancing
- **Database**: Read replicas in multiple regions
- **CDN**: Static asset distribution
- **Redis Cluster**: Distributed caching

## 🔧 Troubleshooting

### Common Issues

**WebRTC Connection Failures**
```bash
# Check TURN server
docker-compose logs coturn

# Test STUN/TURN connectivity
curl https://presence.dlux.io/api/turn-credentials
```

**Database Sync Issues**
```bash
# Check sync service
docker-compose logs sync

# Manual sync trigger
docker-compose exec api node -e "
  require('./sync.js').runSyncCycle()
"
```

**Chat Message Delays**
```bash
# Check Redis connection
docker-compose exec redis redis-cli ping

# Monitor Socket.IO connections
docker-compose logs api | grep Socket
```

## 🚀 Future Enhancements

### Planned Features
- **Spatial Audio**: 3D positional voice chat
- **VR Avatars**: Custom avatar system
- **Screen Sharing**: Share documents/media in VR
- **Recording**: Session recording and playback
- **AI Moderation**: Automated content filtering
- **Mobile VR**: WebXR mobile optimization

### Integration Roadmap
- **Hive Communities**: Community-based VR spaces
- **3Speak**: Video content in VR environments  
- **DLUX Games**: Multi-user VR gaming
- **NFT Galleries**: 3D NFT visualization
- **Virtual Events**: Conferences and meetups

## 🔊 **NEW: VR Audio Environment & Social Monetization System**

### Overview
The enhanced DLUX Presence system now includes a sophisticated audio environment control and payment system that manages the social dynamics of VR spaces:

- **Four Audio Modes**: Complete control over how users hear each other in VR
- **Spatial Audio Intelligence**: AI-assisted social connection algorithms  
- **Payment Integration**: Subscription-based access and profit sharing
- **Ticketing System**: Pay-per-access Q&A participation
- **Permission-based Access**: Multiple layers of access control

### 🎤 Four Audio Environment Modes

#### **Mode 1: Announcement Mode**
- **Only the designated speaker is heard by everyone** (like a lecture)
- All other user-to-user audio is muted
- Perfect for presentations, announcements, keynotes

#### **Mode 2: Stage Mode** 
- **Everyone hears the speaker at full volume**
- **Plus spatial audio from people nearby in VR**
- Like a conference with side conversations during the talk
- Best of both worlds: main content + social interaction

#### **Mode 3: Ambient Mode**
- **Pure spatial audio** - only hear people near your VR avatar
- "Microphone" is turned off - no broadcast speaker
- Like a cocktail party or networking event

#### **Mode 4: Super Ambient Mode**
- **AI ensures everyone has 1-2 conversation partners**
- Regardless of actual VR distance
- Anti-isolation algorithm for social comfort
- Perfect for shy users or sparse events

#### **Admin Controls**
```javascript
// Change audio mode for a space (admin only)
const response = await fetch(`/api/spaces/post/author%2Fpermlink/audio/mode`, {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${hiveSignature}` },
  body: JSON.stringify({
    audio_mode: 'stage', // announcement, stage, ambient, superambient
    spatial_audio_range_meters: 5.0,
    superambient_neighbor_count: 2,
    current_speaker: 'dlux_user' // for announcement/stage modes
  })
});
```

#### **Speaker Role Management**
```javascript
// Request to become the speaker (announcement/stage modes)
const response = await fetch(`/api/spaces/post/author%2Fpermlink/audio/speaker/request`, {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${hiveSignature}` }
});

// Pass speaker role to another user (like a talk show host)
await fetch(`/api/spaces/post/author%2Fpermlink/audio/speaker/pass`, {
  method: 'POST',
  body: JSON.stringify({ target_user: 'dlux_user2' })
});

// Release speaker role when done
await fetch(`/api/spaces/post/author%2Fpermlink/audio/speaker/release`, { 
  method: 'POST' 
});
```

#### **Spatial Audio Management**
```javascript
// Get current spatial connections (who can hear whom)
const connections = await fetch(`/api/spaces/post/author%2Fpermlink/audio/connections`);

// Calculate new spatial connections based on user positions
await fetch(`/api/spaces/post/author%2Fpermlink/audio/calculate-connections`, {
  method: 'POST',
  body: JSON.stringify({
    user_positions: [
      { user_account: 'user1', position: { x: 0, y: 0, z: 0 } },
      { user_account: 'user2', position: { x: 3, y: 0, z: 2 } }
    ]
  })
});
```

#### **Real-Time Events**
```javascript
// Listen for audio environment changes
socket.on('audio-mode-changed', (data) => {
  console.log(`Audio mode changed to ${data.audio_mode} by ${data.changed_by}`);
  // Update audio system based on new mode
  // Reconfigure WebRTC connections
});

socket.on('speaker-role-granted', (data) => {
  console.log(`${data.speaker} is now the main speaker`);
  // Set up broadcast audio for speaker
});

socket.on('speaker-role-passed', (data) => {
  console.log(`Speaker role passed from ${data.from_user} to ${data.to_user}`);
  // Update speaker audio routing
});

socket.on('spatial-connections-updated', (data) => {
  console.log(`Spatial audio updated: ${data.connections.length} connections`);
  // Update WebRTC peer connections based on spatial relationships
});
```

### 💰 Payment & Subscription System

#### **Subscription Tiers**
- **Pro Monthly**: Access to microphone features and priority support
- **Mic Credits**: Pay-per-use microphone access
- **Space Premium**: Enhanced features for space owners

#### **Purchase API**
```javascript
// Buy a monthly subscription
const response = await fetch('/api/payments/purchase', {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${hiveSignature}` },
  body: JSON.stringify({
    purchase_type: 'subscription',
    amount: 10.0,
    currency: 'DLUX',
    payment_method: 'dlux_token'
  })
});

// Buy Q&A access ticket for specific space
const response = await fetch('/api/payments/purchase', {
  method: 'POST',
  body: JSON.stringify({
    purchase_type: 'ticket_purchase',
    space_type: 'post',
    space_id: 'author/permlink',
    ticket_type: 'qna_access',
    amount: 5.0
  })
});
```

#### **Profit Sharing Configuration**
Space owners can configure profit sharing:
```sql
INSERT INTO profit_sharing_config 
(space_type, space_id, space_owner, platform_fee_percent, creator_share_percent)
VALUES ('post', 'author/permlink', 'author', 10.00, 85.00);
```

### 🎫 Access Control & Ticketing

#### **Permission Levels**
1. **Admin**: Space author/creator - can purchase microphones, full control
2. **Moderator**: Community members - can use microphones with restrictions
3. **Subscriber**: Paid users - microphone access with time limits
4. **Ticket Holder**: Per-space paid access - Q&A participation only
5. **Guest**: Free users - listen only

#### **Q&A Participation**
Only users with valid tickets can participate in Q&A sessions:
```javascript
// Check if user can participate in Q&A
const hasTicket = await checkMicrophonePermission(spaceType, spaceId, userAccount);

if (hasTicket) {
  // Allow Q&A participation
  // Show "Request Mic" button
} else {
  // Show "Buy Q&A Access" button
  // Display pricing information
}
```

### 📊 **Database Schema**

#### **New Tables Added**
- `space_microphones` - Virtual microphone configurations
- `microphone_usage` - Usage analytics and billing data
- `user_subscriptions` - Subscription management
- `payment_transactions` - Payment tracking and profit sharing
- `space_tickets` - Per-space access tickets
- `space_permissions` - Enhanced permission system
- `profit_sharing_config` - Revenue sharing settings

### 🔧 **Integration Examples**

#### **Frontend VR Client**
```javascript
class MicrophoneSystem {
  constructor(socket, spaceId) {
    this.socket = socket;
    this.spaceId = spaceId;
    this.currentMicrophone = null;
    this.setupEventListeners();
  }

  setupEventListeners() {
    // Listen for microphone state changes
    this.socket.on('microphone-taken', (data) => {
      if (data.broadcast_mode === 'full_volume') {
        this.enableFullVolumeReceive(data.holder);
      }
      this.updateSpeakerVisual(data.holder, true);
    });

    this.socket.on('microphone-released', () => {
      this.disableFullVolumeReceive();
      this.updateSpeakerVisual(null, false);
    });
  }

  async requestMicrophone(microphoneId) {
    const response = await fetch(`/api/microphones/${microphoneId}/request`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.authToken}` }
    });

    if (response.ok) {
      const data = await response.json();
      this.currentMicrophone = data.microphone;
      this.startBroadcasting(data.microphone.broadcast_mode);
    }
  }

  startBroadcasting(mode) {
    if (mode === 'full_volume' || mode === 'mixed') {
      // Set up WebRTC broadcast to all users
      this.setupBroadcastConnection();
    }
    
    if (mode === 'spatial_only' || mode === 'mixed') {
      // Maintain spatial audio for nearby VR users
      this.maintainSpatialAudio();
    }
  }
}
```

#### **Payment Integration**
```javascript
class PaymentSystem {
  async purchaseQAAccess(spaceType, spaceId) {
    const transaction = await fetch('/api/payments/purchase', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.authToken}` },
      body: JSON.stringify({
        purchase_type: 'ticket_purchase',
        space_type: spaceType,
        space_id: spaceId,
        ticket_type: 'qna_access',
        amount: 5.0,
        payment_method: 'dlux_token'
      })
    });

    if (transaction.confirmation_required) {
      // Handle external payment confirmation
      await this.monitorPaymentChannel(transaction.payment_channel_id);
    }

    return transaction;
  }

  async monitorPaymentChannel(channelId) {
    // Monitor blockchain or payment processor for confirmation
    // This would integrate with Hive, Lightning Network, etc.
  }
}
```

### 🚀 **Deployment Configuration**

#### **Environment Variables**
```bash
# Add to .env file
SYSTEM_ADMINS=admin1,admin2,admin3  # Users who can admin global spaces
TURN_SECRET=your_secure_turn_secret  # For WebRTC authentication

# Payment integration (examples)
HIVE_ACCOUNT=your_hive_account
LIGHTNING_NODE_URL=your_lightning_node
DLUX_TOKEN_CONTRACT=dlux_token_contract_address
```

#### **Redis Configuration**
The system uses Redis for:
- Microphone queues (`mic_queue:{microphoneId}`)
- Payment channel monitoring
- Session caching
- Real-time activity tracking

### 📈 **Analytics & Monitoring**

#### **Usage Analytics**
```sql
-- Get microphone usage statistics
SELECT 
  m.microphone_name,
  COUNT(u.id) as total_sessions,
  AVG(u.duration_seconds) as avg_duration,
  SUM(u.duration_seconds) as total_duration
FROM space_microphones m
LEFT JOIN microphone_usage u ON m.id = u.microphone_id
WHERE m.space_type = 'post' AND m.space_id = 'author/permlink'
GROUP BY m.id, m.microphone_name;
```

#### **Revenue Analytics**
```sql
-- Get space revenue and profit sharing
SELECT 
  space_type,
  space_id,
  space_owner,
  SUM(amount) as total_revenue,
  SUM(platform_fee) as platform_revenue,
  SUM(creator_share) as creator_revenue
FROM payment_transactions
WHERE status = 'confirmed'
GROUP BY space_type, space_id, space_owner;
```

### 🎯 **Use Cases**

1. **Conference/Presentation**: Admin buys main stage mic, passes to speakers
2. **Q&A Session**: Audience buys tickets, gets access to Q&A microphone queue
3. **Community Meeting**: Moderators control discussion flow with mic passing
4. **VIP Events**: Premium ticket holders get priority microphone access
5. **Content Creator Monetization**: Creators earn revenue from mic purchases and Q&A tickets

### 🔐 **Security Considerations**

- **Payment Verification**: All transactions require external confirmation
- **Permission Validation**: Multiple layers of access control
- **Usage Monitoring**: Track microphone usage for billing and abuse prevention
- **Anti-Spam**: Time limits and usage quotas prevent microphone abuse
- **Profit Sharing**: Transparent revenue distribution to content creators

This system creates a new paradigm for VR social interaction and content monetization, allowing creators to directly monetize their spaces while providing users with premium interactive experiences.

---

**The enhanced presence infrastructure provides everything needed for a complete VR social platform while maintaining seamless integration with the existing DLUX ecosystem.** 