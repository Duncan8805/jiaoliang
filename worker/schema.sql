-- 交糧帳雲端資料表（TiDB / MySQL）
-- 在 TiDB Cloud 的 SQL Editor 執行一次即可

CREATE DATABASE IF NOT EXISTS jiaoliang;
USE jiaoliang;

-- 傳票：data 是整張傳票（跟 App 本機的格式一樣），其餘欄位方便查詢
CREATE TABLE IF NOT EXISTS records (
  id         VARCHAR(32)  NOT NULL PRIMARY KEY,
  no         INT          NOT NULL,
  device     VARCHAR(64)  NOT NULL DEFAULT '',
  date       VARCHAR(10)  NOT NULL DEFAULT '',
  name       VARCHAR(100) NOT NULL DEFAULT '',
  period     VARCHAR(50)  NOT NULL DEFAULT '',
  data       JSON         NOT NULL,
  deleted    TINYINT      NOT NULL DEFAULT 0,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  UNIQUE KEY uniq_no (no),          -- 單號全部連號、不可重複（刪除的也佔著號碼）
  KEY idx_updated (updated_at),
  KEY idx_date (date),
  KEY idx_name (name)
);

-- 農民：用姓名當識別（跟 App 一樣）
CREATE TABLE IF NOT EXISTS farmers (
  name       VARCHAR(100) NOT NULL PRIMARY KEY,
  data       JSON         NOT NULL,
  deleted    TINYINT      NOT NULL DEFAULT 0,
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  KEY idx_updated (updated_at)
);

-- 後台設定：只有一列（id = 1）
CREATE TABLE IF NOT EXISTS settings (
  id         TINYINT      NOT NULL PRIMARY KEY,
  data       JSON         NOT NULL,
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  KEY idx_updated (updated_at)
);
