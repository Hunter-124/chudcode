# Acknowledgements — Hunter-124/oh-my-pi fork

This fork exists because a group of us kept hitting the same friction in omp and
started writing it down instead of complaining about it.

## Who did what

**Hunter Edmonds** ([@Hunter-124](https://github.com/Hunter-124)) — orchestrated
the effort, ran the sessions that produced the diagnostics, reported the
reproductions (the OAuth close-window failure, the duplicated status-bar counts,
the `</title>` label leak, the memory exhaustion, the attachment numbering, the
cross-session settings divergence), and handles upstream coordination.

**Michael** ([@iamnotyobabydaddy](https://github.com/iamnotyobabydaddy)) and
**Charles Edmonds** ([@CharlesEdmonds](https://github.com/CharlesEdmonds)) —
contributed the bulk of the ideas and the problem statements behind this work,
including the undo/redo and prompt-preservation priority, the settings
simplification direction, the `/agents` vs `/models/roles` transparency
complaint, and the `/tree` execution-DAG concept. Credited as co-authors on the
commits their ideas drove. Michael handles upstream PR submission.

**Simon Garrison** ([@garrisonsimon](https://github.com/garrisonsimon)) —
participant in the group, repo collaborator.

Implementation and diagnostics were agent-assisted; every change here was
reviewed before it left the fork.

## A note on attribution in this repo

Commit co-authorship in this fork reflects who actually contributed to that
specific change. It is not distributed evenly, and it is not distributed to
round out anyone's contribution graph.

That is a deliberate choice, and a self-interested one: this fork's whole purpose
is to land work upstream in a repository with 27k stars whose `CONTRIBUTING.md`
explicitly says maintainers review "the contributor's understanding" of the
change, not the volume of code. A commit history that credits people who cannot
answer a question about the code is trivially detectable and would cost us
exactly the credibility we are trying to build.

So: if you contributed to something, you are on it. If your name is not on a
commit, it means you did not write or drive that particular change — not that
your input is unwelcome. Ideas, reproductions, and bug reports are real
contributions and are credited above and in the issue reports themselves.

## Upstream

Bug reports filed against [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)
carry the reproduction details and the evidence, and are linked from
`PR-BODIES.md` alongside the branches prepared for submission.
