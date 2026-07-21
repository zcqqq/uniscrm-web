-- Persist a flow's domain (user / content) instead of deriving it from the graph.
--
-- Before this, "is this a content flow?" was answered by sniffing the graph for a content
-- trigger node — in the list query, the editor's node palette and the AI-generate call.
-- Deleting the only trigger therefore turned a content flow into a user flow, and the list
-- query only matched xContentTrigger, so YouTube-only content flows were listed as user flows.
--
-- domain is set at creation and never changes afterwards.
ALTER TABLE flows ADD COLUMN domain TEXT NOT NULL DEFAULT 'user';

UPDATE flows SET domain = 'content'
  WHERE graph_json LIKE '%xContentTrigger%'
     OR graph_json LIKE '%youtubeContentTrigger%';
