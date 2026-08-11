-- Per-provider image model, alongside the existing text `model` column. NULL means
-- "this tenant has not configured an image model for this provider" — for BYOK providers
-- that is a real, load-bearing state (the provider is then not offered in flow's image
-- provider dropdown). The 'default' provider never needs it: getDefaultImageModel falls
-- back to the same constant the text side uses for `model`.
ALTER TABLE tenant_llm_credentials ADD COLUMN image_model TEXT;
