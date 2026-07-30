# Company skill maps — public evidence only

**What this is.** For each large technology company and systems integrator, a
map of the **publicly observable** engineering stack: the languages, platforms,
frameworks and open standards they build on and, where they publish it, their
own open source and engineering practice.

**What this is not.** None of these companies publish their internal
playbooks, proprietary processes, or employee know-how, and none of that is in
this pack or reproducible from it. A "skill map" here means *what a competent
engineer working in that ecosystem, from public materials, would need to know* —
not a leak of anything internal. Treat every entry as "the public face of how
this company builds," and say so plainly to anyone who assumes otherwise.

Each map lists: the public stack, the company's own open source (where it
exists), the relevant standards, and the catalog domains to route through for
that company's kind of work. Slugs here are covered by the verified catalog.

---

## Microsoft
- **Public stack:** C#/.NET, TypeScript, Azure, Entra ID, Microsoft Graph, SQL
  Server, Power Platform, Windows, Dynamics 365.
- **Own open source:** `dotnet/*`, `Azure/*`, `microsoft/TypeScript`,
  `microsoft/vscode`, `microsoft/playwright`, `microsoft/semantic-kernel`.
- **Standards:** OpenAPI, OData, OAuth2/OIDC via Entra.
- **Route via:** microsoft, cloud-devops, security → `microsoft-enterprise-engineer`.

## Google / Alphabet
- **Public stack:** Go, Java, Kotlin, C++, Python, GCP, Angular, Flutter,
  Android, TensorFlow/JAX.
- **Own open source:** `golang/go`, `google/*`, `GoogleCloudPlatform/*`,
  `android/*`, `bazelbuild/bazel`, `grpc/grpc`, `google/eng-practices`.
- **Practice, published:** `google/eng-practices` (code review),
  `google/styleguide`, `google-research/tuning_playbook`.
- **Route via:** google, cloud-devops, ai-agents → `google-cloud-android-engineer`.

## Apple
- **Public stack:** Swift, Objective-C, SwiftUI/UIKit, Core ML, MLX, server-side
  Swift, Xcode toolchain.
- **Own open source:** `apple/swift`, `apple/swift-nio`, `apple/foundationdb`,
  `ml-explore/mlx`, `apple/pkl`, `apple/container`.
- **Standards:** App Store guidelines, WebKit/WHATWG, OAuth via AppAuth.
- **Route via:** apple, web-mobile-ui → `apple-platform-engineer`.

## Oracle
- **Public stack:** Java/JVM, PL/SQL, Oracle Database, GraalVM, WebLogic, OCI,
  Helidon, Coherence.
- **Own open source:** `openjdk/jdk`, `oracle/graal`, `oracle/helidon`,
  `oracle/weblogic-kubernetes-operator`, `mysql/mysql-server`.
- **Standards:** Jakarta EE, JPA, JDBC, SQL:2016.
- **Route via:** oracle-java, data-engineering → `oracle-database-engineer`.

## SAP
- **Public stack:** ABAP / Clean ABAP, RAP, CAP, Fiori/UI5, OData, HANA, BTP.
- **Own open source:** `SAP/styleguides` (Clean ABAP), `SAP/cloud-sdk`,
  `SAP/ui5-webcomponents`, `SAP-samples/cap-sflight`, `abapGit/abapGit`.
- **Standards:** OData (OASIS), OpenUI5.
- **Route via:** sap-ibm-legacy → `sap-enterprise-engineer`.

## NVIDIA
- **Public stack:** CUDA/C++, Python, TensorRT, Triton, NCCL, RAPIDS, Omniverse,
  Isaac.
- **Own open source:** `NVIDIA/cuda-samples`, `NVIDIA/cutlass`,
  `NVIDIA/TensorRT-LLM`, `NVIDIA/Megatron-LM`, `rapidsai/*`, `NVIDIA/NeMo`.
- **Standards:** OpenUSD, MaterialX, OCI (containers), Kubernetes device plugins.
- **Route via:** nvidia-gpu, llm-infra → `nvidia-cuda-engineer`.

## IBM / Red Hat
- **Public stack:** Java, COBOL/z-Series, Db2, MQ, WebSphere/Liberty, OpenShift,
  Ansible, watsonx.
- **Own open source:** `openliberty/open-liberty`, `eclipse/microprofile`,
  `zowe/*` (Open Mainframe), `ansible/ansible`, `openshift/*`, `IBM/*`.
- **Standards:** MicroProfile, Jakarta EE, SCAP/OSCAL (via ComplianceAsCode).
- **Route via:** sap-ibm-legacy, cloud-devops → `ibm-mainframe-engineer`.

---

## Systems integrators — TCS, Infosys, Wipro, HCLTech, Tech Mahindra, Accenture, Capgemini, Cognizant, LTIMindtree

These firms deliver *on other vendors' platforms*. Their differentiator is
delivery capability and domain knowledge, both of which are private. What is
public is:

1. **The platforms they staff around** — Salesforce, SAP, ServiceNow, Adobe,
   Microsoft, AWS, GCP, Pega, Camunda, MuleSoft, Temporal, Odoo/ERPNext. These
   are all in the `it-services`, `microsoft`, `google`, `sap-ibm-legacy` and
   `cloud-devops` catalog domains.
2. **Their own open source**, which is modest and catalogued where it exists:
   `Accenture/mercury`, `Accenture/AmpliGraph`,
   `Accenture/reactive-interaction-gateway`, `CognizantOneDevOps/Insights`.

There is no public repository of any integrator's internal delivery playbook,
estimation model, or accelerator IP. A request to "build like Accenture does"
is answered by mastering the public platforms above and applying the
engineering discipline the specialist agents already encode — not by any claim
of inside knowledge. Route this work through `enterprise-integration-engineer`,
`solutions-architect`, and the relevant platform specialist.
