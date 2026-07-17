import { Service } from "encore.dev/service";

// The offer service manages digital offer letters with a native
// e-signature flow: HR drafts and sends → candidate signs via a secure
// tokenized link → an authorized signatory countersigns → the sealed,
// fully-signed PDF is issued to both parties with an audit trail.
export default new Service("offer");
