/**
 * BYOK credential encryption — re-exported from the public, independently
 * auditable `uniscrm-byok` package (https://github.com/zcqqq/uniscrm-byok).
 *
 * This file exists only so existing relative imports (`./crypto`,
 * `./services/crypto`) keep working; the actual implementation is not
 * duplicated here. Production runs the exact code published in that repo.
 */
export { encrypt, decrypt, generateMasterKey } from "uniscrm-byok";
