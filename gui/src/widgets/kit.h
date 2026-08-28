#pragma once

#include <string>
#include <string_view>

#include <imgui.h>

#include "theme/theme.h"

namespace chud::kit {

enum class Tone { Neutral, Accent, Ok, Warn, Err, Info };

[[nodiscard]] ImVec4 toneVec(Tone tone);
[[nodiscard]] ImU32 toneU32(Tone tone);
[[nodiscard]] ImVec4 toneOn(Tone tone, ImVec4 surface);

enum class Density { Compact, Cozy, Roomy };

struct DensityMetrics {
    float padX;
    float padY;
    float rowGap;
    float rowRound;
    float chipRound;
    float sectionGap;
    float headGap;
    float gutter;
};

[[nodiscard]] Density density();
[[nodiscard]] DensityMetrics densityMetrics();
[[nodiscard]] DensityMetrics densityMetrics(Density value);
void pushDensity(Density value);
void popDensity();

class DensityScope final {
  public:
    explicit DensityScope(Density value);
    ~DensityScope();
    DensityScope(const DensityScope&) = delete;
    DensityScope& operator=(const DensityScope&) = delete;
};

// ImDrawListSplitter has no automatic merge. This guard makes every exit path,
// including an early return, restore the draw list to a single channel.
class DrawListSplitScope final {
  public:
    explicit DrawListSplitScope(ImDrawList* drawList, int channels = 2);
    ~DrawListSplitScope();
    DrawListSplitScope(const DrawListSplitScope&) = delete;
    DrawListSplitScope& operator=(const DrawListSplitScope&) = delete;
    void channel(int index);

  private:
    ImDrawList* drawList_;
    ImDrawListSplitter splitter_;
    int channels_;
};

struct CardOptions {
    const char* title = nullptr;
    bool* open = nullptr;
    Tone tint = Tone::Neutral;
    bool selected = false;
};

// cardEnd is required even when cardBegin returns false. The false value only
// means the caller should skip the body; the collapsed header still exists.
[[nodiscard]] bool cardBegin(const char* id, const CardOptions& options = {});
void cardEnd();
void cardHeaderRight(float width);

struct SectionOptions {
    const char* trailing = nullptr;
    int count = -1;
    bool first = false;
};

void sectionHeader(const char* label, const SectionOptions& options = {});

struct RowStyle {
    const char* secondary = nullptr;
    const char* meta = nullptr;
    const char* tooltip = nullptr;
    bool selected = false;
    bool disabled = false;
    float actionsWidth = 0.0f;
    float minimumHeight = 0.0f;
    Tone iconTone = Tone::Neutral;
};

[[nodiscard]] bool row(const char* id, const char* title,
                       const RowStyle& style = {});
[[nodiscard]] bool rowBegin(const char* id, const RowStyle& style = {});
void rowEnd();

[[nodiscard]] bool chip(const char* label, Tone tone = Tone::Neutral);
[[nodiscard]] bool valueChip(const char* label, const char* value,
                            Tone tone = Tone::Neutral);
[[nodiscard]] bool toggleChip(const char* label, bool* value,
                             Tone tone = Tone::Accent);

[[nodiscard]] bool primaryButton(const char* label, ImVec2 size = {},
                                 bool enabled = true,
                                 const char* disabledReason = nullptr);
[[nodiscard]] bool secondaryButton(const char* label, ImVec2 size = {},
                                   bool enabled = true,
                                   const char* disabledReason = nullptr);
[[nodiscard]] bool dangerButton(const char* label, ImVec2 size = {},
                                bool enabled = true,
                                const char* disabledReason = nullptr);

enum class Status { Pending, Running, Done, Failed, Retry, Skipped };

[[nodiscard]] Tone statusTone(Status status);
void statusGlyph(ImDrawList* drawList, ImVec2 center, float radius, Status status);
void statusGlyphInline(Status status, float size = 0.0f);
void inlineStatus(Status status, const char* label);
void progressBar(float fraction, ImVec2 size = {}, Tone tone = Tone::Accent,
                 const char* overlay = nullptr);
void spinner(const char* label);

// Empty means no content yet; blocked means a named dependency is wrong. Both
// return true only when their optional recovery/action button is pressed.
[[nodiscard]] bool emptyState(const char* title, const char* body,
                              const char* actionLabel = nullptr);
[[nodiscard]] bool blockedState(const char* reason, const char* hint,
                                const char* actionLabel = nullptr);

void dimText(const char* text);
void keyValueRow(const char* key, const char* value,
                 Tone tone = Tone::Neutral, bool copyable = false);
[[nodiscard]] std::string elide(std::string_view text, float maxWidth);
void rule();
void gapRow();
void gapSection();

}  // namespace chud::kit
