UPDATE flows SET graph_json = REPLACE(
  REPLACE(graph_json, '"type":"eventHistory"', '"type":"waitForEvent"'),
  '"type":"trigger"', '"type":"xTrigger"'
) WHERE graph_json LIKE '%"type":"eventHistory"%' OR graph_json LIKE '%"type":"trigger"%';
