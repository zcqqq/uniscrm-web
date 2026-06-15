CREATE TABLE user_x (
  id TEXT PRIMARY KEY,
  name TEXT,
  username TEXT,
  profile_image_url TEXT,
  raw_data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
