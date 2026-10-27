# Contributing to Chudcode

Pull requests are welcome. Keep them focused, understand the work you submit,
and be prepared to explain and maintain it.

## Before you start

### Small changes

Bug fixes, documentation updates, and narrowly scoped improvements can go
straight to a pull request.

### Major changes

Discuss major features and broad architectural or behavioral changes in a
[repository issue](https://github.com/Hunter-124/chudcode/issues) before writing
the implementation. This includes new subsystems, large UI changes, new
dependencies, and changes that span several packages. Prior discussion does not
guarantee that a pull request will be merged.

Search existing issues and pull requests first, and link relevant discussions
from your pull request. Report vulnerabilities through the
[security policy](.github/SECURITY.md), not a public issue.

## AI-assisted contributions

AI agents are welcome as tools, not as unattended contributors. Do not give an
agent a vague goal and submit whatever it produces.

Before opening a pull request, you must:

- constrain the agent to the agreed scope and reject unrelated changes;
- review every changed file and understand the resulting behavior;
- run the relevant checks and exercise the changed behavior yourself; and
- submit the pull request only after that review, rather than letting an agent
  publish it autonomously.

You are responsible for the code, regardless of who or what generated it.

## Pull request requirements

Every pull request body **MUST include at least one sentence written by you, in
your own words**, explaining what changed and why. A generated summary, pasted
agent transcript, or checklist alone does not satisfy this requirement.

One honest line is enough:

> I reviewed the full diff; this change fixes duplicate PR reviews by reusing
> the existing delivery guard.

You **MUST verify that the change works as intended**. `bun check` and automated
tests are expected where relevant, but they are not proof that the behavior
works. Exercise the changed path yourself and report the exact scenario and
result in the pull request:

- for a bug fix, reproduce the bug and confirm the same reproduction no longer
  fails;
- for a feature, launch the product and use the feature end to end; and
- for a UI change, interact with it and inspect the rendered result.

“`bun check` passes” by itself is not sufficient verification. For coding-agent
development commands and repository structure, see
[`packages/coding-agent/DEVELOPMENT.md`](packages/coding-agent/DEVELOPMENT.md).

For installation and native build prerequisites, start with the
[repository README](README.md#development). Chudcode is Chudware's runtime
dependency; CAD host integration changes belong in
[Chudware](https://github.com/Hunter-124/Chudware).

Keep each pull request to one logical change. Avoid unrelated cleanup,
drive-by refactors, generated noise, or features that were not part of the
agreed scope.

## Contribution licensing

A contribution intentionally submitted for inclusion in Chudcode is licensed
under the MIT License.

This policy does not relicense third-party or vendored code. You must have the
right to submit your contribution and must preserve applicable copyright,
license, attribution, and notice material. Submitting a contribution does not
require signing a Contributor License Agreement (CLA) or certifying a
Developer Certificate of Origin (DCO).

## Review

Maintainers review the submitted behavior and the contributor's understanding
of it—not the volume of generated code. Respond to review feedback yourself,
and only apply suggestions you have checked.

Pull requests may be closed when they skip required prior discussion, lack the
human-written explanation, contain unreviewed agent output, or mix unrelated
changes.
