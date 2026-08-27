#include "panels.h"

#include "fixture.h"
#include "kit.h"
#include "theme.h"
#include "text_wrap.h"

#include "imgui.h"
#include "imgui_internal.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstring>
#include <string>
#include <unordered_map>

namespace omp::gui {
namespace {

bool gInitialScroll = true;
bool gScrollToLatest = false;
std::array<char, 4096> gComposer{
    "Connect this shell to the active omp session and preserve selection while new events stream in."
};

const std::array<PanelSpec, 2> kPanels{{
    {"transcript", "Transcript", "conversationFixture", "transcript.v1", &drawTranscriptPanel},
    {"composer", "Composer", "composerDraft", "composer.v1", &drawComposerPanel},
}};

struct ProseCache {
    std::string source;
    float width = 0.0F;
    ImFont* font = nullptr;
    float fontSize = 0.0F;
    WrappedText wrapped;
};

std::unordered_map<ImGuiID, ProseCache> gProseCache;

int lineCount(const std::string& text) {
    return 1 + static_cast<int>(std::count(text.begin(), text.end(), '\n'));
}

void normalizeCopiedSelection(const WrappedText& wrapped) {
    const ImGuiIO& io = ImGui::GetIO();
    const bool copyPressed =
        (io.KeyCtrl || io.KeySuper) &&
        (ImGui::IsKeyPressed(ImGuiKey_C, false) || ImGui::IsKeyPressed(ImGuiKey_Insert, false));
    if (!copyPressed) return;

    ImGuiInputTextState* state = ImGui::GetInputTextState(ImGui::GetItemID());
    if (state == nullptr || !state->HasSelection()) return;
    const int selectionStart = std::min(state->GetSelectionStart(), state->GetSelectionEnd());
    const int selectionEnd = std::max(state->GetSelectionStart(), state->GetSelectionEnd());
    const std::size_t begin = utf8ByteOffset(wrapped.text, selectionStart);
    const std::size_t end = utf8ByteOffset(wrapped.text, selectionEnd);
    const std::string normalized = normalizeSoftBreaks(wrapped, begin, end);
    ImGui::SetClipboardText(normalized.c_str());
}

void drawReadOnlyBox(const char* id, std::string& text, const ImVec4& background,
                     const ImVec4& foreground, float maxHeight, bool horizontalScroll) {
    const float boxWidth = std::max(1.0F, ImGui::GetContentRegionAvail().x - 12.0F);
    std::string* displayed = &text;
    const WrappedText* wrapped = nullptr;
    if (!horizontalScroll) {
        const float wrapWidth = std::max(
            1.0F, boxWidth - ImGui::GetStyle().FramePadding.x * 2.0F -
                      ImGui::GetStyle().ScrollbarSize - 4.0F);
        const ImGuiID widgetId = ImGui::GetID(id);
        ImFont* font = ImGui::GetFont();
        const float fontSize = ImGui::GetFontSize();
        ProseCache& cache = gProseCache[widgetId];
        if (cache.source != text || std::fabs(cache.width - wrapWidth) > 0.5F ||
            cache.font != font || cache.fontSize != fontSize) {
            cache.source = text;
            cache.width = wrapWidth;
            cache.font = font;
            cache.fontSize = fontSize;
            cache.wrapped = wrapProse(text, wrapWidth, *font, fontSize);
        }
        displayed = &cache.wrapped.text;
        wrapped = &cache.wrapped;
    }

    const float height = std::min(maxHeight,
                                  lineCount(*displayed) * ImGui::GetTextLineHeight() +
                                      ImGui::GetStyle().FramePadding.y * 2.0F + 4.0F);
    ImGui::PushStyleColor(ImGuiCol_FrameBg, background);
    ImGui::PushStyleColor(ImGuiCol_Text, foreground);
    ImGui::PushStyleColor(ImGuiCol_Border, omp::ui::palette().border);
    ImGui::PushStyleVar(ImGuiStyleVar_FrameBorderSize, 1.0F);
    ImGuiInputTextFlags flags = ImGuiInputTextFlags_ReadOnly;
    if (!horizontalScroll) {
        flags |= ImGuiInputTextFlags_NoHorizontalScroll;
    }
    ImGui::InputTextMultiline(id, displayed->data(), displayed->size() + 1,
                              {boxWidth, height}, flags);
    if (wrapped != nullptr) normalizeCopiedSelection(*wrapped);
    ImGui::PopStyleVar();
    ImGui::PopStyleColor(3);
}

void drawDiff(const std::string& label, const std::string& text) {
    const omp::ui::Palette& p = omp::ui::palette();
    omp::ui::kit::dimText(label.c_str());
    ImGui::PushStyleColor(ImGuiCol_ChildBg, p.codeBg);
    ImGui::PushStyleColor(ImGuiCol_Border, p.border);
    ImGui::BeginChild("##diff_lines", {std::max(1.0F, ImGui::GetContentRegionAvail().x - 12.0F), 160.0F},
                      ImGuiChildFlags_Borders,
                      ImGuiWindowFlags_HorizontalScrollbar | ImGuiWindowFlags_AlwaysHorizontalScrollbar);
    std::size_t start = 0;
    while (start <= text.size()) {
        const std::size_t end = text.find('\n', start);
        const std::string line = text.substr(start, end == std::string::npos ? std::string::npos : end - start);
        const ImVec4* color = &p.proseText;
        if (line.rfind("@@", 0) == 0) {
            color = &p.diffHunk;
        } else if (line.rfind("diff ", 0) == 0 || line.rfind("index ", 0) == 0) {
            color = &p.diffHeader;
        } else if (!line.empty() && line[0] == '+') {
            color = &p.diffAdd;
        } else if (!line.empty() && line[0] == '-') {
            color = &p.diffDelete;
        }
        ImGui::PushStyleColor(ImGuiCol_Text, *color);
        ImGui::TextUnformatted(line.c_str());
        ImGui::PopStyleColor();
        if (end == std::string::npos) break;
        start = end + 1;
    }
    ImGui::EndChild();
    ImGui::PopStyleColor(2);
}

void drawPart(MessagePart& part, int partIndex) {
    const omp::ui::Palette& p = omp::ui::palette();
    ImGui::PushID(partIndex);
    switch (part.kind) {
        case PartKind::Prose:
            drawReadOnlyBox("##selectable_prose", part.text, p.proseBg, p.proseText, 150.0F, false);
            break;
        case PartKind::Code:
            omp::ui::kit::dimText(part.label.c_str());
            drawReadOnlyBox("##copyable_code", part.text, p.codeBg, p.proseText, 220.0F, true);
            break;
        case PartKind::Diff:
            drawDiff(part.label, part.text);
            break;
    }
    ImGui::PopID();
}

void drawMessage(Message& message, int messageIndex) {
    const bool user = message.speaker == Speaker::User;
    const omp::ui::Palette& p = omp::ui::palette();
    const ImVec4& tint = user ? p.accentSoft : p.panelBg;
    ImGui::PushID(messageIndex);
    omp::ui::kit::cardBegin("message", nullptr, nullptr, &tint);

    if (user) {
        omp::ui::kit::statusGlyph(omp::ui::kit::Tone::Accent, 8.0F);
        ImGui::SameLine();
    }
    ImGui::TextUnformatted(message.author.c_str());
    const float timeWidth = ImGui::CalcTextSize(message.timestamp.c_str()).x + 12.0F;
    omp::ui::kit::cardHeaderRight(timeWidth);
    omp::ui::kit::dimText(message.timestamp.c_str());
    omp::ui::kit::rule();

    if (user) {
        ImGui::PushStyleColor(ImGuiCol_Text, p.text);
        ImGui::PushTextWrapPos(ImGui::GetCursorPosX() +
                               std::min(1040.0F, ImGui::GetContentRegionAvail().x - 12.0F));
        ImGui::TextUnformatted(message.parts.front().text.c_str());
        ImGui::PopTextWrapPos();
        ImGui::PopStyleColor();
    } else {
        for (int i = 0; i < static_cast<int>(message.parts.size()); ++i) {
            if (i != 0) ImGui::Dummy({0.0F, 4.0F});
            drawPart(message.parts[i], i);
        }
    }
    omp::ui::kit::cardEnd();
    ImGui::PopID();
}

void sendComposerText() {
    if (gComposer[0] == '\0') return;
    conversationFixture().push_back({
        Speaker::User,
        "You",
        "now",
        {{PartKind::Prose, {}, gComposer.data()}},
    });
    gComposer.fill('\0');
    gScrollToLatest = true;
}

}  // namespace

const std::array<PanelSpec, 2>& panelRegistry() {
    return kPanels;
}

void drawTranscriptPanel() {
    if (!ImGui::Begin(kPanels[0].title)) {
        ImGui::End();
        return;
    }

    omp::ui::kit::sectionHeader("ACTIVE SESSION", "fixture", static_cast<int>(conversationFixture().size()), true);
    ImGui::BeginChild("##transcript_view", {0.0F, 0.0F}, ImGuiChildFlags_None,
                      ImGuiWindowFlags_AlwaysVerticalScrollbar);
    {
        omp::ui::kit::DensityScope compact(omp::ui::kit::Density::Compact);
        std::vector<Message>& messages = conversationFixture();
        std::array<float, 64> messageBoundaries{};
        int messageBoundaryCount = 0;
        if (messages.empty()) {
            omp::ui::kit::emptyState("No messages", "Start with the composer below.");
        } else {
            for (int i = 0; i < static_cast<int>(messages.size()); ++i) {
                if (messageBoundaryCount < static_cast<int>(messageBoundaries.size())) {
                    messageBoundaries[messageBoundaryCount++] = ImGui::GetCursorPosY();
                }
                drawMessage(messages[i], i);
                if (i + 1 != static_cast<int>(messages.size())) {
                    ImGui::Dummy({0.0F, 6.0F});
                }
            }
        }
        if (gInitialScroll) {
            const float maxScroll = ImGui::GetScrollMaxY();
            if (maxScroll > 0.0F) {
                float boundary = 0.0F;
                for (int i = 0; i < messageBoundaryCount; ++i) {
                    if (messageBoundaries[i] > maxScroll + 0.5F) break;
                    boundary = messageBoundaries[i];
                }
                ImGui::SetScrollY(boundary);
                gInitialScroll = false;
            }
        }
        if (gScrollToLatest) {
            ImGui::SetScrollHereY(1.0F);
            gScrollToLatest = false;
        }
    }
    ImGui::EndChild();
    ImGui::End();
}

void drawComposerPanel() {
    if (!ImGui::Begin(kPanels[1].title)) {
        ImGui::End();
        return;
    }

    ImGui::BeginChild("##composer_view", {0.0F, 0.0F}, ImGuiChildFlags_None,
                      ImGuiWindowFlags_NoScrollbar);
    omp::ui::kit::sectionHeader("PROMPT", "local fixture", -1, true);

    omp::ui::kit::chip("source", "AGENTS.md", omp::ui::kit::Tone::Info, true,
                       "Attached project instructions");
    ImGui::SameLine();
    omp::ui::kit::chip("selection", "theme.cpp:58-94", omp::ui::kit::Tone::Accent, false,
                       "Attached source selection");
    ImGui::SameLine();
    omp::ui::kit::iconButton("attach", "+", "Attach a file", {34.0F, 0.0F});

    const float buttonWidth = 104.0F;
    const float editorWidth = std::max(1.0F, ImGui::GetContentRegionAvail().x - buttonWidth -
                                                ImGui::GetStyle().ItemSpacing.x);
    ImGui::PushStyleColor(ImGuiCol_FrameBg, omp::ui::palette().proseBg);
    ImGui::InputTextMultiline("##composer_input", gComposer.data(), gComposer.size(),
                              {editorWidth, 92.0F}, ImGuiInputTextFlags_None);
    ImGui::PopStyleColor();
    ImGui::SameLine();
    if (omp::ui::kit::primaryButton("Send", {buttonWidth, 92.0F})) {
        sendComposerText();
    }

    omp::ui::kit::statusGlyph(omp::ui::kit::Tone::Positive, 8.0F);
    ImGui::SameLine();
    omp::ui::kit::dimText("Ready  |  Enter a prompt, then send");
    ImGui::EndChild();
    ImGui::End();
}

}  // namespace omp::gui
