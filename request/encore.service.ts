import { Service } from "encore.dev/service";

// The request service manages HR employee requests (visa, Iqama, letters, etc.)
// with a review-and-complete workflow.
export default new Service("request");
