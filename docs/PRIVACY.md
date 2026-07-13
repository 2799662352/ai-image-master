# Privacy Policy

Effective date: July 13, 2026

This policy describes data handling in the official open-source builds of CATIMATION Cyberpunk Master distributed from the [project repository](https://github.com/2799662352/ai-image-master).

## Local data

The application stores settings, provider credentials, prompts, generated media, project history, agent conversations, and attachments on the user's device. This data is not sent to the project maintainer by default.

Users can remove local data through the application's controls or by uninstalling the application and deleting its application-data directory.

## User-requested network services

The application transfers information to networked systems when the user enables or invokes features that require them. Depending on the selected feature and configuration, transferred data can include prompts, reference images, generated media, documents, API credentials, and agent requests.

Destinations can include:

- AI model providers or API gateways selected or configured by the user.
- Cloud storage configured by the user, including R2- or COS-compatible services.
- MCP servers, plugins, connectors, or custom endpoints enabled by the user.
- GitHub and the project's distribution infrastructure for release downloads.

These services process data under their own terms and privacy policies. Users are responsible for reviewing the policy of each provider they choose. Common third-party policies include:

- [Google Privacy Policy](https://policies.google.com/privacy)
- [OpenAI Privacy Policy](https://openai.com/policies/privacy-policy/)
- [Tencent Cloud Privacy Policy](https://www.tencentcloud.com/document/product/301/17345)
- [Cloudflare Privacy Policy](https://www.cloudflare.com/privacypolicy/)
- [GitHub Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement)

Custom gateways and connectors may have different operators and policies.

## Automatic network requests

Official builds may contact project-controlled or third-party infrastructure to:

- Check for application updates and download release metadata.
- Load marketplace catalogs, skills, plugins, or other user-requested resources.
- Load web-hosted assets required by enabled features.

Hosting and network providers may retain standard server logs such as IP address, request time, requested URL, and user-agent information according to their own retention policies.

## Diagnostics and analytics

Official builds do not intentionally send product analytics to the project maintainer by default. Optional tracing integrations are inactive unless a custom build operator configures the required credentials; operators of custom builds are responsible for disclosing their own data practices.

## Security

Credentials are intended to remain in local application storage and are transmitted only to the service for which the user configured them. No storage or transmission method can be guaranteed completely secure, so users should use restricted API keys and revoke credentials that may have been exposed.

## Contact

Privacy questions can be sent to [zuozuoliang999@gmail.com](mailto:zuozuoliang999@gmail.com).

