-- Rollback for migration 0001.
-- Drops only the tables this migration created, in reverse dependency order.
-- Does not touch the Vercel Blob data store or any existing data anywhere.
-- Safe to run even if some of these tables don't exist (IF EXISTS).

DROP TABLE IF EXISTS tasks;
DROP TABLE IF EXISTS projects;
DROP TABLE IF EXISTS task_statuses;
DROP TABLE IF EXISTS services;
DROP TABLE IF EXISTS clients;
DROP TABLE IF EXISTS users;
