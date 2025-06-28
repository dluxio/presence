-- Setup PostgreSQL read replica for presence server

-- Create replication user if not exists
DO $$ 
BEGIN
   IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'replica_user') THEN
      CREATE ROLE replica_user WITH REPLICATION LOGIN ENCRYPTED PASSWORD 'replica_password';
   END IF;
END
$$;

-- Configure replication settings
ALTER SYSTEM SET wal_level = 'replica';
ALTER SYSTEM SET max_wal_senders = 3;
ALTER SYSTEM SET max_replication_slots = 3;
ALTER SYSTEM SET hot_standby = on;
ALTER SYSTEM SET hot_standby_feedback = on;

-- Reload configuration
SELECT pg_reload_conf();

-- Create database if not exists
SELECT 'CREATE DATABASE webrtc_db'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'webrtc_db')\gexec

-- Grant permissions
GRANT CONNECT ON DATABASE webrtc_db TO replica_user;

-- DLUX Presence Database Setup
-- This sets up a local read replica with presence-specific enhancements

-- Database is created by docker-compose.yml via POSTGRES_DB environment variable
-- Connect to the database
\c dlux_presence;

-- Create replica user
DO $$ 
BEGIN
   IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'replica_user') THEN
      CREATE ROLE replica_user WITH LOGIN REPLICATION ENCRYPTED PASSWORD 'replica_password_2024';
   END IF;
END
$$;

-- Grant permissions
GRANT CONNECT ON DATABASE dlux_presence TO replica_user;
GRANT USAGE ON SCHEMA public TO replica_user;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO replica_user;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO replica_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO replica_user;

-- ==================================================================
-- REPLICATED CORE TABLES (synced from data.dlux.io)
-- ==================================================================

-- Posts table (subset for VR spaces)
CREATE TABLE posts (
    author varchar(16) NOT NULL,
    permlink varchar(255) NOT NULL,
    block int,
    votes int,
    type varchar(16),
    rating int,
    nsfw boolean DEFAULT false,
    hidden boolean DEFAULT false,
    flagged boolean DEFAULT false,
    title text,
    content text,
    created_at timestamp DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (author, permlink)
);

-- Collaboration documents (subset for VR spaces)
CREATE TABLE collaboration_documents (
    id SERIAL PRIMARY KEY,
    title varchar(255) NOT NULL,
    content text,
    creator varchar(16) NOT NULL,
    is_public boolean DEFAULT false,
    created_at timestamp DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp DEFAULT CURRENT_TIMESTAMP
);

-- Document permissions
CREATE TABLE collaboration_permissions (
    id SERIAL PRIMARY KEY,
    document_id INTEGER REFERENCES collaboration_documents(id) ON DELETE CASCADE,
    user_account varchar(16) NOT NULL,
    permission varchar(20) DEFAULT 'read', -- read, write, admin
    granted_by varchar(16) NOT NULL,
    created_at timestamp DEFAULT CURRENT_TIMESTAMP
);

-- ==================================================================
-- PRESENCE-SPECIFIC TABLES (local to presence.dlux.io)
-- ==================================================================

-- VR presence sessions
CREATE TABLE presence_sessions (
    id SERIAL PRIMARY KEY,
    socket_id varchar(255) UNIQUE NOT NULL,
    user_account varchar(16), -- Hive account (null for guests)
    space_type varchar(20) NOT NULL, -- 'post', 'document', 'global'
    space_id varchar(255) NOT NULL, -- post author/permlink, document id, 'lobby'
    subspace varchar(255) DEFAULT 'main', -- subroom within the space
    position jsonb, -- VR position/rotation
    avatar_data jsonb, -- avatar configuration
    voice_enabled boolean DEFAULT false,
    connected_at timestamp DEFAULT CURRENT_TIMESTAMP,
    last_activity timestamp DEFAULT CURRENT_TIMESTAMP
);

-- VR space settings (configuration for different spaces)
CREATE TABLE presence_space_settings (
    id SERIAL PRIMARY KEY,
    space_type varchar(20) NOT NULL, -- 'post', 'document', 'global'
    space_id varchar(255) NOT NULL, -- identifier for the space
    settings jsonb NOT NULL DEFAULT '{}', -- VR scene settings, spawn points, etc.
    chat_enabled boolean DEFAULT true,
    voice_enabled boolean DEFAULT true,
    max_users integer DEFAULT 50,
    created_by varchar(16) NOT NULL,
    created_at timestamp DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(space_type, space_id)
);

-- ==================================================================
-- CHAT AND MESSAGING SYSTEM
-- ==================================================================

-- Chat messages in VR spaces
CREATE TABLE chat_messages (
    id SERIAL PRIMARY KEY,
    space_type varchar(20) NOT NULL,
    space_id varchar(255) NOT NULL,
    subspace varchar(255) DEFAULT 'main',
    user_account varchar(16), -- null for guest users
    guest_id varchar(255), -- for guest users
    message_type varchar(20) DEFAULT 'text', -- text, emoji, system, voice_transcription
    content text NOT NULL,
    metadata jsonb, -- reactions, mentions, formatting
    parent_message_id INTEGER REFERENCES chat_messages(id), -- for threading
    thread_count integer DEFAULT 0, -- number of replies
    is_edited boolean DEFAULT false,
    is_deleted boolean DEFAULT false,
    created_at timestamp DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp DEFAULT CURRENT_TIMESTAMP
);

-- Document comments (enhanced for VR collaboration)
CREATE TABLE document_comments (
    id SERIAL PRIMARY KEY,
    document_id INTEGER REFERENCES collaboration_documents(id) ON DELETE CASCADE,
    user_account varchar(16) NOT NULL,
    content text NOT NULL,
    comment_type varchar(20) DEFAULT 'comment', -- comment, suggestion, approval, question
    document_section varchar(255), -- which part of document
    position_data jsonb, -- VR position if made in VR
    parent_comment_id INTEGER REFERENCES document_comments(id), -- for threading
    thread_count integer DEFAULT 0,
    is_resolved boolean DEFAULT false,
    is_edited boolean DEFAULT false,
    is_deleted boolean DEFAULT false,
    created_at timestamp DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp DEFAULT CURRENT_TIMESTAMP
);

-- Real-time chat subscriptions
CREATE TABLE chat_subscriptions (
    id SERIAL PRIMARY KEY,
    user_account varchar(16) NOT NULL,
    space_type varchar(20) NOT NULL,
    space_id varchar(255) NOT NULL,
    notification_settings jsonb DEFAULT '{"mentions": true, "all_messages": false}',
    last_read_message_id INTEGER REFERENCES chat_messages(id),
    last_read_at timestamp DEFAULT CURRENT_TIMESTAMP,
    created_at timestamp DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_account, space_type, space_id)
);

-- Message reactions (emoji responses)
CREATE TABLE message_reactions (
    id SERIAL PRIMARY KEY,
    message_id INTEGER REFERENCES chat_messages(id) ON DELETE CASCADE,
    user_account varchar(16) NOT NULL,
    reaction varchar(50) NOT NULL, -- emoji unicode or name
    created_at timestamp DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(message_id, user_account, reaction)
);

-- ==================================================================
-- WEBHOOKS AND INTEGRATIONS
-- ==================================================================

-- Webhook subscriptions for real-time updates
CREATE TABLE webhook_subscriptions (
    id SERIAL PRIMARY KEY,
    space_type varchar(20) NOT NULL,
    space_id varchar(255) NOT NULL,
    webhook_url text NOT NULL,
    events text[] NOT NULL, -- array of event types
    secret varchar(255), -- for webhook verification
    is_active boolean DEFAULT true,
    created_by varchar(16) NOT NULL,
    created_at timestamp DEFAULT CURRENT_TIMESTAMP
);

-- Activity feed for spaces
CREATE TABLE space_activity (
    id SERIAL PRIMARY KEY,
    space_type varchar(20) NOT NULL,
    space_id varchar(255) NOT NULL,
    user_account varchar(16),
    activity_type varchar(50) NOT NULL, -- join, leave, chat, voice_start, document_edit
    activity_data jsonb,
    is_public boolean DEFAULT true, -- whether to show in public activity feed
    created_at timestamp DEFAULT CURRENT_TIMESTAMP
);

-- ==================================================================
-- INDEXES FOR PERFORMANCE
-- ==================================================================

-- Presence sessions indexes
CREATE INDEX idx_presence_sessions_user ON presence_sessions(user_account);
CREATE INDEX idx_presence_sessions_space ON presence_sessions(space_type, space_id);
CREATE INDEX idx_presence_sessions_activity ON presence_sessions(last_activity);
CREATE INDEX idx_presence_sessions_socket ON presence_sessions(socket_id);

-- Chat message indexes
CREATE INDEX idx_chat_messages_space ON chat_messages(space_type, space_id, subspace);
CREATE INDEX idx_chat_messages_user ON chat_messages(user_account);
CREATE INDEX idx_chat_messages_created ON chat_messages(created_at);
CREATE INDEX idx_chat_messages_thread ON chat_messages(parent_message_id);

-- Document comment indexes
CREATE INDEX idx_document_comments_doc ON document_comments(document_id);
CREATE INDEX idx_document_comments_user ON document_comments(user_account);
CREATE INDEX idx_document_comments_thread ON document_comments(parent_comment_id);
CREATE INDEX idx_document_comments_created ON document_comments(created_at);

-- Activity indexes
CREATE INDEX idx_space_activity_space ON space_activity(space_type, space_id);
CREATE INDEX idx_space_activity_user ON space_activity(user_account);
CREATE INDEX idx_space_activity_created ON space_activity(created_at);
CREATE INDEX idx_space_activity_type ON space_activity(activity_type);

-- Space settings indexes
CREATE INDEX idx_presence_space_settings_space ON presence_space_settings(space_type, space_id);

-- Subscription indexes
CREATE INDEX idx_chat_subscriptions_user ON chat_subscriptions(user_account);

-- ==================================================================
-- FUNCTIONS AND TRIGGERS
-- ==================================================================

-- Update thread count when new reply is added
CREATE OR REPLACE FUNCTION update_thread_count()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.parent_message_id IS NOT NULL THEN
        UPDATE chat_messages 
        SET thread_count = thread_count + 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = NEW.parent_message_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER chat_thread_count_trigger
    AFTER INSERT ON chat_messages
    FOR EACH ROW
    EXECUTE FUNCTION update_thread_count();

-- Same for document comments
CREATE OR REPLACE FUNCTION update_comment_thread_count()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.parent_comment_id IS NOT NULL THEN
        UPDATE document_comments 
        SET thread_count = thread_count + 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = NEW.parent_comment_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER comment_thread_count_trigger
    AFTER INSERT ON document_comments
    FOR EACH ROW
    EXECUTE FUNCTION update_comment_thread_count();

-- Clean up old sessions
CREATE OR REPLACE FUNCTION cleanup_old_sessions()
RETURNS void AS $$
BEGIN
    DELETE FROM presence_sessions 
    WHERE last_activity < NOW() - INTERVAL '1 hour';
    
    DELETE FROM space_activity 
    WHERE created_at < NOW() - INTERVAL '30 days';
END;
$$ LANGUAGE plpgsql;

-- Create a scheduled job to run cleanup (requires pg_cron extension)
-- SELECT cron.schedule('cleanup-sessions', '0 * * * *', 'SELECT cleanup_old_sessions();');

-- ==================================================================
-- SAMPLE DATA FOR DEVELOPMENT
-- ==================================================================

-- Insert global lobby space settings
INSERT INTO presence_space_settings (space_type, space_id, settings, created_by) VALUES
('global', 'lobby', '{"theme": "modern", "spawn_points": [{"x": 0, "y": 0, "z": 0}], "background": "space"}', 'system');

-- Insert sample collaboration document
INSERT INTO collaboration_documents (id, title, content, creator, is_public) VALUES
(1, 'VR Development Guidelines', 'This document outlines best practices for VR development in DLUX.', 'admin', true);

COMMIT; 