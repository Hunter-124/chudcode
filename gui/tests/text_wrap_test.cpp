#include "fixture.h"
#include "text_wrap.h"

#include "imgui.h"

#include <iostream>
#include <stdexcept>
#include <cfloat>
#include <string>

#include <algorithm>

namespace {

float widestLine(const omp::gui::WrappedText& wrapped, ImFont& font, float fontSize) {
    float widest = 0.0F;
    std::size_t start = 0;
    while (start <= wrapped.text.size()) {
        const std::size_t end = wrapped.text.find('\n', start);
        const char* beginPtr = wrapped.text.data() + start;
        const char* endPtr = end == std::string::npos ? wrapped.text.data() + wrapped.text.size()
                                                       : wrapped.text.data() + end;
        widest = std::max(widest, font.CalcTextSizeA(fontSize, FLT_MAX, 0.0F, beginPtr, endPtr).x);
        if (end == std::string::npos) break;
        start = end + 1;
    }
    return widest;
}

}  // namespace

int main() {
    ImGui::CreateContext();
    ImGuiIO& io = ImGui::GetIO();
    ImFont* font = io.Fonts->AddFontDefault();
    unsigned char* pixels = nullptr;
    int atlasWidth = 0;
    int atlasHeight = 0;
    io.Fonts->GetTexDataAsRGBA32(&pixels, &atlasWidth, &atlasHeight);
    if (pixels == nullptr || atlasWidth <= 0 || atlasHeight <= 0) {
        throw std::runtime_error("default font atlas did not build");
    }

    const std::string source =
        "A selectable assistant paragraph should wrap at word boundaries without adding copy artifacts.\n"
        "This hard break must survive, including  double spaces and a-long-token-that-needs-splitting.";
    const omp::gui::WrappedText wrapped =
        omp::gui::wrapProse(source, 180.0F, *font, font->FontSize);
    if (wrapped.softBreaks.empty()) {
        throw std::runtime_error("fixture did not exercise soft wrapping");
    }
    if (omp::gui::normalizeSoftBreaks(wrapped) != source) {
        throw std::runtime_error("wrap/normalize changed source bytes or hard breaks");
    }

    const std::size_t hardBreak = source.find('\n');
    if (hardBreak == std::string::npos || source.find('\n', hardBreak + 1) != std::string::npos) {
        throw std::runtime_error("test fixture hard-break invariant is invalid");
    }
    constexpr float fixtureWrapWidth = 1450.0F;
    std::size_t fixtureSoftBreaks = 0;
    float fixtureWidestLine = 0.0F;
    for (omp::gui::Message& message : omp::gui::conversationFixture()) {
        if (message.speaker != omp::gui::Speaker::Assistant) continue;
        for (omp::gui::MessagePart& part : message.parts) {
            if (part.kind != omp::gui::PartKind::Prose) continue;
            const omp::gui::WrappedText fixtureWrapped =
                omp::gui::wrapProse(part.text, fixtureWrapWidth, *font, font->FontSize);
            if (omp::gui::normalizeSoftBreaks(fixtureWrapped) != part.text) {
                throw std::runtime_error("fixture prose changed during wrap/normalize");
            }
            fixtureSoftBreaks += fixtureWrapped.softBreaks.size();
            fixtureWidestLine = std::max(fixtureWidestLine,
                                         widestLine(fixtureWrapped, *font, font->FontSize));
            if (fixtureWidestLine > fixtureWrapWidth + 0.01F) {
                throw std::runtime_error("fixture prose exceeds its measured wrap width");
            }
        }
    }
    if (fixtureSoftBreaks == 0) {
        throw std::runtime_error("real assistant fixture did not exercise wrapping");
    }

    std::cout << "round trip preserved " << source.size() << " bytes, 1 hard break, and "
              << wrapped.softBreaks.size() << " synthetic breaks; fixture added "
              << fixtureSoftBreaks << " breaks with widest row " << fixtureWidestLine
              << "px in a " << fixtureWrapWidth << "px box\n";
    ImGui::DestroyContext();
    return 0;
}
