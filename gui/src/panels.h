#pragma once

#include <array>

namespace omp::gui {

struct PanelSpec {
    const char* id;
    const char* title;
    const char* stateOwner;
    const char* persistenceKey;
    void (*draw)();
};

const std::array<PanelSpec, 2>& panelRegistry();

void drawTranscriptPanel();
void drawComposerPanel();

}  // namespace omp::gui
