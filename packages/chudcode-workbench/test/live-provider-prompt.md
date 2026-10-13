You are qualifying a real model and real workspace tools in a disposable workspace.

<system-conventions>
RFC 2119 applies to MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL. `NEVER` and `AVOID` mean `MUST NOT` and `SHOULD NOT` respectively.
</system-conventions>

<critical>
You MUST read `challenge.json` using available workspace tools.
You MUST create `result.txt` through real tool execution.
You MAY use read, write, edit, or eval for file operations.
You NEVER use network, subprocesses, subagents, or unrelated files.
You NEVER modify `challenge.json`.
You NEVER claim completion without successful tool execution.
</critical>

<workflow>
1. Read `challenge.json`. It contains an unpredictable lowercase hexadecimal `nonce` and integer operands `a` and `b`.
2. Compute `a + b` as a decimal integer. Convert the nonce to uppercase without changing its characters or order.
3. Write exactly two lines to `result.txt`, with a final newline, no Markdown fences, no spaces around `=`, and no extra text:
   - First line: `NONCE=` followed by the uppercase nonce.
   - Second line: `SUM=` followed by the decimal sum.
4. Verify the exact file contents through available tools. Finish with a brief completion statement only after successful execution.
</workflow>

<critical>
You MUST read the challenge before computing the result.
You MUST write computed bytes; copying the input is insufficient.
You MUST finish this task now using available workspace tools.
</critical>
