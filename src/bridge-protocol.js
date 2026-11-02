/**
 * Protocol constants for the shared DeepSeek account route.
 *
 * These are the facts that both the bridge and the tools around it must
 * agree on: which provider Pi talks to, which header carries the dsh account
 * token, and where that token lives.
 *
 * Everything here was measured against the live DeepSeek API, not guessed:
 *
 *   - The dsh account token is accepted only in the `x-dsh-auth-token`
 *     header. Sent as `Authorization: Bearer` it is rejected with 401.
 *   - A valid `x-dsh-auth-token` wins over `Authorization`. A non-empty but
 *     invalid one fails the request with 401 and no fallback, so the token
 *     command must never emit a placeholder.
 *   - An empty or absent `x-dsh-auth-token` behaves as absent and lets
 *     `Authorization` carry the request.
 *
 * The token itself is never stored here. It stays in the dsh credentials
 * file and is read on demand.
 */

/** The provider id Pi uses for DeepSeek. Replaced, never added. */
export const SHARED_PROVIDER_ID = 'deepseek';

/** The only header DeepSeek accepts the dsh account token in. */
export const ACCOUNT_TOKEN_HEADER = 'x-dsh-auth-token';

/** DeepSeek's OpenAI-compatible endpoint. */
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

/** The Pi API family that speaks to it. */
export const DEEPSEEK_API = 'openai-completions';

/**
 * The non-empty apiKey a models.json provider needs to be considered
 * authenticated by Pi. It is never used to authenticate: the account token
 * in the header is what authorises the request. It exists because Pi refuses
 * a provider with no auth method at all.
 */
export const SHARED_ACCOUNT_PLACEHOLDER = 'shared-account';

/** The models Pi resolves for the shared provider. */
export const SHARED_MODELS = ['deepseek-flash', 'deepseek-v4-pro'];

/** The dsh credential record that holds the account grant. */
export const GRANT_RECORD_KEY = 'deepseek-account-platform/default';

/**
 * The three states every credential check reports. "Present" alone never
 * means "working": a key on an account with no credit is present and still
 * fails every request.
 */
export const CREDENTIAL_STATES = ['absent', 'present-but-unusable', 'usable'];
