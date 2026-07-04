import { Service } from "encore.dev/service";

// The expense service manages company and employee expenses with an
// approval workflow (manager → admin → finance) and email notifications.
export default new Service("expense");
