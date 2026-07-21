// @ts-expect-error RuntimeDispatchOwnership is not a current schema-barrel contract.
import type { RuntimeDispatchOwnership } from '../../src/schemas/index.js';

// @ts-expect-error ActivationCompletionOutcome is replaced by current activation contracts.
import type { ActivationCompletionOutcome } from '../../src/schemas/index.js';

// @ts-expect-error ActivationCompletionEnvelopeV1 is not a current completion contract.
import type { ActivationCompletionEnvelopeV1 } from '../../src/schemas/index.js';

// @ts-expect-error RuntimeRunStatus is not a current runtime-control contract.
import type { RuntimeRunStatus } from '../../src/schemas/index.js';

// @ts-expect-error ProjectRunCompletedPayload is not a current card-process contract.
import type { ProjectRunCompletedPayload } from '../../src/schemas/index.js';

// @ts-expect-error HandoffSummary is not a current card-process contract.
import type { HandoffSummary } from '../../src/schemas/index.js';
