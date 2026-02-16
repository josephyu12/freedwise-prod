-- Migration: Add unarchived_at column to highlights
-- This allows the auto-archive logic to only count low ratings
-- that occurred AFTER the highlight was manually unarchived.

ALTER TABLE highlights ADD COLUMN unarchived_at timestamptz;
