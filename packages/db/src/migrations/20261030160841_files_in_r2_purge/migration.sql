-- A file whose chunks are in R2 leaves its ID behind when its row goes, however it goes:
-- removed, its upload cancelled or left unfinished, or with its item, vault, account or
-- workspace through the cascades. The Worker deletes the objects later.
CREATE TRIGGER `attachment_purge_r2` AFTER DELETE ON `attachment`
WHEN old.`stored_in` = 'r2'
BEGIN
	INSERT OR IGNORE INTO `file_purge` (`attachment_id`, `chunks`) VALUES (old.`id`, old.`chunks`);
END;
