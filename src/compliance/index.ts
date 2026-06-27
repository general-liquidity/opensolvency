// Compliance subpath (`@general-liquidity/agentworth/compliance`) — regulated-finance
// reporting over the signed governance audit chain:
//  - `deployerOversightReport` maps the chain + mandates to EU AI Act Article 26
//    (deployer-oversight: human oversight, monitoring, record-keeping).
//  - `exportCompliancePackage` / `verifyCompliancePackage` produce + independently verify
//    a signed compliance package (chain + report + integrity proof), so an auditor/regulator
//    can check it without trusting the producer.
export * from "./oversight.ts";
export {
  exportCompliancePackage,
  verifyCompliancePackage,
  type CompliancePackage,
  COMPLIANCE_PACKAGE_VERSION,
} from "../audit/export.ts";
