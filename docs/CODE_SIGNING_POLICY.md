# Code signing policy

Free code signing provided by [SignPath.io](https://signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

This policy covers official Windows release artifacts for CATIMATION Cyberpunk Master that are linked from the [project repository](https://github.com/2799662352/ai-image-master).

## Team roles

- **Author and committer:** [zuo liang (`@2799662352`)](https://github.com/2799662352) maintains the source code and build configuration.
- **Reviewer:** zuo liang reviews contributions from other authors before they are merged.
- **Approver:** zuo liang manually approves each SignPath signing request for an official release.

## Build and signing controls

- Release artifacts must be produced from this public repository by the project's GitHub Actions workflow.
- Only tagged release commits and artifacts produced by the documented automated build may be submitted for signing.
- Signing requests require manual approval by the approver.
- The project certificate must only sign CATIMATION-owned binaries. Bundled upstream dependencies must retain their upstream signatures or remain unsigned.
- Product name and version metadata must match the corresponding release.
- Build scripts and CI configuration are treated as security-sensitive source code.

## Privacy

The project's data handling practices are documented in the [Privacy Policy](PRIVACY.md).

