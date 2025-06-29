-- Setup PostgreSQL read replica for presence server (READ-ONLY)
-- All write operations are handled by data.dlux.io

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

-- DLUX Presence Database Setup (READ-ONLY REPLICA)
-- This is a read replica that syncs from data.dlux.io
-- All writes are handled by data.dlux.io API endpoints

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

-- Grant permissions (READ-ONLY)
GRANT CONNECT ON DATABASE dlux_presence TO replica_user;
GRANT USAGE ON SCHEMA public TO replica_user;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO replica_user;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO replica_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO replica_user;

-- ==================================================================
-- REPLICATED CORE TABLES (synced from data.dlux.io)
-- These tables are populated by replication, not local writes
-- ==================================================================

-- Posts table (subset for VR spaces)
CREATE TABLE IF NOT EXISTS posts (
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

-- NOTE: The following tables are created on-demand by data.dlux.io
-- They may or may not exist in this replica depending on replication status:
-- - presence_sessions (real-time session data)
-- - chat_messages (chat history)
-- - space_activity (activity logs)
-- - collaboration_documents (document collaboration)
-- - document_comments (document comments)
-- - space_audio_config (VR audio settings)
-- - audio_sessions (speaker sessions)

-- ==================================================================
-- INDEXES FOR PERFORMANCE (READ-ONLY)
-- ==================================================================

-- Basic indexes for posts
CREATE INDEX IF NOT EXISTS idx_posts_type ON posts(type);
CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author);
CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at);
CREATE INDEX IF NOT EXISTS idx_posts_rating ON posts(rating);
CREATE INDEX IF NOT EXISTS idx_posts_votes ON posts(votes);

-- Cleanup function (safe for read-only replica)
CREATE OR REPLACE FUNCTION log_replica_status()
RETURNS void AS $$
BEGIN
    -- Log that this is a read-only replica
    RAISE NOTICE 'DLUX Presence: Read-only replica initialized. All writes go to data.dlux.io';
END;
$$ LANGUAGE plpgsql;

-- Call the log function
SELECT log_replica_status();

COMMIT; 