#pragma once

#include "imgui.h"

#include <cstdint>
#include <string>

namespace omp::ui::kit {

enum class Tone { Neutral, Accent, Positive, Warning, Danger, Info };
enum class Density { Compact, Cozy, Roomy };

class DensityScope {
public:
    explicit DensityScope(Density value);
    ~DensityScope();
    DensityScope(const DensityScope&) = delete;
    DensityScope& operator=(const DensityScope&) = delete;
};

Density density();
float densityScale();

struct RowStyle {
    Tone tone = Tone::Neutral;
    const char* secondary = nullptr;
    const char* meta = nullptr;
    const char* tooltip = nullptr;
    bool selected = false;
    bool disabled = false;
    float actionWidth = 0.0F;
};

bool cardBegin(const char* id, const char* title = nullptr, bool* open = nullptr,
               const ImVec4* tint = nullptr);
void cardEnd();
void cardHeaderRight(float width);
void sectionHeader(const char* label, const char* trailing = nullptr, int count = -1,
                   bool first = false);
bool row(const char* id, const char* title, const RowStyle& style = {});

bool chip(const char* id, const char* label, Tone tone = Tone::Neutral,
          bool selected = false, const char* tooltip = nullptr);
bool primaryButton(const char* label, const ImVec2& size = {});
bool secondaryButton(const char* label, const ImVec2& size = {});
bool iconButton(const char* id, const char* asciiLabel, const char* tooltip,
                const ImVec2& size = {});
void statusGlyph(Tone tone, float diameter = 8.0F);
void progressBar(float fraction, const ImVec2& size = {}, const char* overlay = nullptr);
void spinner(const char* id, float radius = 7.0F, float thickness = 2.0F);
void emptyState(const char* title, const char* detail = nullptr);
void dimText(const char* text);
void keyValueRow(const char* key, const char* value);
void rule();

std::string fmtAgo(std::int64_t secondsAgo);
std::string fmtCount(std::int64_t count);

}  // namespace omp::ui::kit
