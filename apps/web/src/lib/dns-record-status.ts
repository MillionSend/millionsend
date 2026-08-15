// Pure record-status logic lives in @millionsend/core (client-safe subpath) so
// the web verify mutation and the worker cron share one source of truth. This
// re-export keeps the client-component import path (dns-records-table) stable.
export {
  combineRecordStatus,
  type LiveDnsStatus,
  type RecordStatus,
  type SesGate,
  sesGateFromRecordStatus,
} from "@millionsend/core/domain-status";
