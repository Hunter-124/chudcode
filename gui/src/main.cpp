#include "panels.h"
#include "theme.h"

#include "imgui.h"
#include "imgui_internal.h"
#include "imgui_impl_glfw.h"
#include "imgui_impl_opengl3.h"

#include <GLFW/glfw3.h>

#include <algorithm>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

struct Options {
    int width = 1600;
    int height = 1000;
    int frames = 8;
    std::string screenshotPath;
};

void glfwError(int code, const char* description) {
    std::cerr << "GLFW error " << code << ": " << description << '\n';
}

Options parseOptions(int argc, char** argv) {
    Options options;
    for (int i = 1; i < argc; ++i) {
        const std::string argument = argv[i];
        auto requireValue = [&](const char* option) -> const char* {
            if (++i >= argc) throw std::runtime_error(std::string(option) + " requires a value");
            return argv[i];
        };
        if (argument == "--screenshot") {
            options.screenshotPath = requireValue("--screenshot");
        } else if (argument == "--frames") {
            options.frames = std::stoi(requireValue("--frames"));
        } else if (argument == "--width") {
            options.width = std::stoi(requireValue("--width"));
        } else if (argument == "--height") {
            options.height = std::stoi(requireValue("--height"));
        } else if (argument == "--help") {
            std::cout << "usage: omp-gui [--width N] [--height N] [--screenshot path.ppm] [--frames N]\n";
            std::exit(EXIT_SUCCESS);
        } else {
            throw std::runtime_error("unknown option: " + argument);
        }
    }
    if (options.width < 320 || options.height < 240 || options.frames < 1) {
        throw std::runtime_error("width, height, and frame count must be positive and usable");
    }
    return options;
}

void buildDockLayout(ImGuiID dockspaceId, const ImVec2& size) {
    ImGui::DockBuilderRemoveNode(dockspaceId);
    ImGui::DockBuilderAddNode(dockspaceId, ImGuiDockNodeFlags_DockSpace);
    ImGui::DockBuilderSetNodeSize(dockspaceId, size);
    ImGuiID transcriptNode = dockspaceId;
    ImGuiID composerNode = 0;
    ImGui::DockBuilderSplitNode(transcriptNode, ImGuiDir_Down, 0.26F, &composerNode, &transcriptNode);
    const auto& panels = omp::gui::panelRegistry();
    ImGui::DockBuilderDockWindow(panels[0].title, transcriptNode);
    ImGui::DockBuilderDockWindow(panels[1].title, composerNode);
    ImGui::DockBuilderFinish(dockspaceId);
}

void drawDockHost() {
    const ImGuiViewport* viewport = ImGui::GetMainViewport();
    ImGui::SetNextWindowPos(viewport->WorkPos);
    ImGui::SetNextWindowSize(viewport->WorkSize);
    ImGui::SetNextWindowViewport(viewport->ID);

    constexpr ImGuiWindowFlags hostFlags =
        ImGuiWindowFlags_NoDocking | ImGuiWindowFlags_NoTitleBar |
        ImGuiWindowFlags_NoCollapse | ImGuiWindowFlags_NoResize |
        ImGuiWindowFlags_NoMove | ImGuiWindowFlags_NoBringToFrontOnFocus |
        ImGuiWindowFlags_NoNavFocus | ImGuiWindowFlags_MenuBar;
    ImGui::PushStyleVar(ImGuiStyleVar_WindowRounding, 0.0F);
    ImGui::PushStyleVar(ImGuiStyleVar_WindowBorderSize, 0.0F);
    ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding, {0.0F, 0.0F});
    ImGui::Begin("omp desktop##dock_host", nullptr, hostFlags);
    ImGui::PopStyleVar(3);

    if (ImGui::BeginMenuBar()) {
        ImGui::TextUnformatted("omp desktop");
        ImGui::SameLine();
        ImGui::TextDisabled("  local fixture  |  session transport next");
        ImGui::EndMenuBar();
    }

    const ImGuiID dockspaceId = ImGui::GetID("omp_dockspace_v1");
    if (ImGui::DockBuilderGetNode(dockspaceId) == nullptr) {
        buildDockLayout(dockspaceId, viewport->WorkSize);
    }
    ImGui::DockSpace(dockspaceId, {0.0F, 0.0F}, ImGuiDockNodeFlags_PassthruCentralNode);
    ImGui::End();
}

bool writeScreenshot(const std::string& path, int width, int height) {
    std::vector<unsigned char> pixels(static_cast<std::size_t>(width) * height * 3);
    glPixelStorei(GL_PACK_ALIGNMENT, 1);
    glReadBuffer(GL_BACK);
    glFinish();
    glReadPixels(0, 0, width, height, GL_RGB, GL_UNSIGNED_BYTE, pixels.data());

    std::ofstream output(path, std::ios::binary);
    if (!output) return false;
    output << "P6\n" << width << ' ' << height << "\n255\n";
    const std::size_t rowBytes = static_cast<std::size_t>(width) * 3;
    for (int y = height - 1; y >= 0; --y) {
        output.write(reinterpret_cast<const char*>(pixels.data() + static_cast<std::size_t>(y) * rowBytes),
                     static_cast<std::streamsize>(rowBytes));
    }
    return output.good();
}

}  // namespace

int main(int argc, char** argv) {
    try {
        const Options options = parseOptions(argc, argv);
        const bool screenshotMode = !options.screenshotPath.empty();
        glfwSetErrorCallback(glfwError);
        if (glfwInit() != GLFW_TRUE) return EXIT_FAILURE;

        glfwWindowHint(GLFW_CONTEXT_VERSION_MAJOR, 3);
        glfwWindowHint(GLFW_CONTEXT_VERSION_MINOR, 3);
        glfwWindowHint(GLFW_OPENGL_PROFILE, GLFW_OPENGL_CORE_PROFILE);
        if (screenshotMode) glfwWindowHint(GLFW_VISIBLE, GLFW_FALSE);
        GLFWwindow* window = glfwCreateWindow(options.width, options.height, "omp desktop", nullptr, nullptr);
        if (window == nullptr) {
            glfwTerminate();
            return EXIT_FAILURE;
        }
        glfwMakeContextCurrent(window);
        glfwSwapInterval(screenshotMode ? 0 : 1);

        IMGUI_CHECKVERSION();
        ImGui::CreateContext();
        ImGuiIO& io = ImGui::GetIO();
        io.ConfigFlags |= ImGuiConfigFlags_NavEnableKeyboard;
        io.ConfigFlags |= ImGuiConfigFlags_DockingEnable;
        io.IniFilename = screenshotMode ? nullptr : "omp_gui_v1.ini";

        // The requested UI fonts are absent on this host. ImGui's built-in ProggyClean
        // remains narrow, readable, and monospace, and no affordance relies on a glyph.
        omp::ui::applyTheme(1.0F);
        io.Fonts->AddFontDefault();
        ImGui_ImplGlfw_InitForOpenGL(window, true);
        ImGui_ImplOpenGL3_Init("#version 330");

        int renderedFrames = 0;
        while (!glfwWindowShouldClose(window)) {
            glfwPollEvents();
            ImGui_ImplOpenGL3_NewFrame();
            ImGui_ImplGlfw_NewFrame();
            ImGui::NewFrame();

            drawDockHost();
            for (const omp::gui::PanelSpec& panel : omp::gui::panelRegistry()) {
                panel.draw();
            }

            ImGui::Render();
            int framebufferWidth = 0;
            int framebufferHeight = 0;
            glfwGetFramebufferSize(window, &framebufferWidth, &framebufferHeight);
            glViewport(0, 0, framebufferWidth, framebufferHeight);
            const ImVec4& clear = omp::ui::palette().windowBg;
            glClearColor(clear.x, clear.y, clear.z, clear.w);
            glClear(GL_COLOR_BUFFER_BIT);
            ImGui_ImplOpenGL3_RenderDrawData(ImGui::GetDrawData());

            ++renderedFrames;
            if (screenshotMode && renderedFrames >= options.frames) {
                if (!writeScreenshot(options.screenshotPath, framebufferWidth, framebufferHeight)) {
                    throw std::runtime_error("could not write screenshot: " + options.screenshotPath);
                }
                std::cout << "wrote " << options.screenshotPath << " (" << framebufferWidth << 'x'
                          << framebufferHeight << ", " << renderedFrames << " frames)\n";
                break;
            }
            glfwSwapBuffers(window);
        }

        ImGui_ImplOpenGL3_Shutdown();
        ImGui_ImplGlfw_Shutdown();
        ImGui::DestroyContext();
        glfwDestroyWindow(window);
        glfwTerminate();
        return EXIT_SUCCESS;
    } catch (const std::exception& error) {
        std::cerr << "omp-gui: " << error.what() << '\n';
        return EXIT_FAILURE;
    }
}
