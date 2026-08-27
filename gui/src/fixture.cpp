#include "fixture.h"

namespace omp::gui {

std::vector<Message>& conversationFixture() {
    static std::vector<Message> messages{
        {
            Speaker::User,
            "You",
            "10:42",
            {{PartKind::Prose, {},
              "The terminal transcript is getting in my way. Build a desktop shell that keeps long output readable, lets me select assistant text normally, and gives the composer enough room for a real prompt."}},
        },
        {
            Speaker::Assistant,
            "omp",
            "10:42",
            {
                {PartKind::Prose, {},
                 "I inspected the UI conventions and started with the smallest useful shell: a docked transcript, a persistent composer, semantic theme roles, and selectable output. The first pass stays local and uses a fixture so layout and interaction can be exercised before session transport is connected."},
                {PartKind::Code, "gui/src/session_view.cpp",
                 "struct SessionView {\n"
                 "    std::string id;\n"
                 "    std::vector<Message> messages;\n"
                 "    bool stick_to_latest = true;\n"
                 "};\n\n"
                 "void drawSession(SessionView& session) {\n"
                 "    drawTranscript(session);\n"
                 "    drawComposer(session);\n"
                 "}"},
            },
        },
        {
            Speaker::User,
            "You",
            "10:44",
            {{PartKind::Prose, {},
              "Make the change reviewable too. I want additions, removals, and hunk headers to remain obvious without turning the whole application into a neon diff viewer."}},
        },
        {
            Speaker::Assistant,
            "omp",
            "10:44",
            {
                {PartKind::Prose, {},
                 "Done. Diff color is confined to line meaning, while the surrounding card stays on the same panel and code surfaces as the rest of the shell. The transcript owns one scroll region and follows the tail with a current-frame anchor rather than cached scroll bounds."},
                {PartKind::Diff, "gui/src/transcript.cpp",
                 "diff --git a/gui/src/transcript.cpp b/gui/src/transcript.cpp\n"
                 "index 31b2c13..71b9ad0 100644\n"
                 "--- a/gui/src/transcript.cpp\n"
                 "+++ b/gui/src/transcript.cpp\n"
                 "@@ -44,7 +44,10 @@ void drawTranscript(Session& session) {\n"
                 "-    ImGui::TextUnformatted(message.text.c_str());\n"
                 "+    drawSelectableProse(message.text);\n"
                 "+    if (session.stick_to_latest) {\n"
                 "+        ImGui::SetScrollHereY(1.0f);\n"
                 "+    }\n"
                 " }"},
                {PartKind::Prose, {},
                 "The next workstream can replace this fixture with omp events without changing the shell's visual contract."},
            },
        },
    };
    return messages;
}

}  // namespace omp::gui
