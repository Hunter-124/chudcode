#include "app/app.h"

#include <algorithm>
#include <array>
#include <chrono>
#include <cctype>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <initializer_list>
#include <limits>
#include <map>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <thread>
#include <type_traits>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

#include <GLFW/glfw3.h>
#include <imgui.h>
#include <imgui_impl_glfw.h>
#include <imgui_impl_opengl3.h>

#include "copilot/copilot_view.h"
#include "editor/editor.h"
#include "graph/graph_view.h"
#include "graph/session_dag_view.h"
#include "icons/icons.h"
#include "net/ws_transport.h"
#include "protocol/desktop_client.h"
#include "protocol/desktop_store.h"
#include "terminal/terminal_model.h"
#include "terminal/terminal_view.h"
#include "theme/anim.h"
#include "theme/theme.h"
#include "vcs/vcs_view.h"
#include "widgets/kit.h"
#include "workspace/workspace_view.h"

namespace chud::app {
namespace {

namespace fs = std::filesystem;

constexpr std::string_view kProduct = "Chudcode";
constexpr std::string_view kVersion = "0.2.0";
constexpr int kMinimumWidth = 800;
constexpr int kMinimumHeight = 560;
constexpr std::uint64_t kDefaultScreenshotFrames = 300;

std::string environment(const char* name) {
    const char* value = std::getenv(name);
    return value == nullptr ? std::string{} : std::string(value);
}

bool environmentEnabled(const char* name) {
    const auto value = environment(name);
    return value == "1" || value == "true" || value == "yes" || value == "on";
}

std::string_view optionValue(int& index, int argc, const char* const* argv,
                             std::string_view option) {
    const std::string_view argument(argv[index]);
    const std::string prefix = std::string(option) + "=";
    if (argument.starts_with(prefix)) {
        const auto value = argument.substr(prefix.size());
        if (value.empty()) throw UsageError("missing value for " + std::string(option));
        return value;
    }
    if (argument == option) {
        if (index + 1 >= argc) throw UsageError("missing value for " + std::string(option));
        const std::string_view value(argv[++index]);
        if (value.empty()) throw UsageError("missing value for " + std::string(option));
        return value;
    }
    return {};
}

std::uint64_t parsePositive(std::string_view text, std::string_view option,
                            std::uint64_t maximum) {
    std::uint64_t value = 0;
    for (const char character : text) {
        if (character < '0' || character > '9') {
            throw UsageError(std::string(option) + " requires a positive integer");
        }
        const auto digit = static_cast<std::uint64_t>(character - '0');
        if (value > (maximum - digit) / 10U) {
            throw UsageError(std::string(option) + " is out of range");
        }
        value = value * 10U + digit;
    }
    if (value == 0) throw UsageError(std::string(option) + " must be greater than zero");
    return value;
}

std::string safeOptionName(std::string_view argument) {
    const auto separator = argument.find('=');
    return std::string(argument.substr(0, separator));
}

fs::path dataDirectory() {
    auto root = environment("XDG_DATA_HOME");
    fs::path directory;
    if (!root.empty()) {
        directory = fs::path(root);
    } else {
        const auto home = environment("HOME");
        directory = home.empty() ? fs::temp_directory_path() : fs::path(home) / ".local" / "share";
    }
    directory /= "Chudcode";
    directory /= "chudcode-gui";
    directory /= std::string(kVersion);
    fs::create_directories(directory);
    return directory;
}

#if defined(GLFW_PLATFORM) && defined(GLFW_PLATFORM_X11)
/// Whether a Wayland compositor socket is actually reachable.
///
/// GLFW aborts initialization instead of falling back when it selects Wayland and
/// the connection then fails, so the platform choice cannot be inferred from
/// WAYLAND_DISPLAY being merely present: libwayland ignores an empty value and an
/// unset one, falling back to `$XDG_RUNTIME_DIR/wayland-0` either way. Resolve the
/// socket exactly as libwayland does and check that it exists.
bool waylandSocketPresent() {
    auto display = environment("WAYLAND_DISPLAY");
    if (display.empty()) display = "wayland-0";
    fs::path socket(display);
    if (!socket.is_absolute()) {
        const auto runtimeDir = environment("XDG_RUNTIME_DIR");
        if (runtimeDir.empty()) return false;
        socket = fs::path(runtimeDir) / display;
    }
    std::error_code error;
    return fs::exists(socket, error);
}
#endif

// Nearest ancestor `assets/` directory containing any of `markers` (relative
// paths), searched from the working directory and the executable's directory.
// Two distinct roots exist: the repo-root brand assets (logo sources) and the
// GUI runtime assets (fonts + icon atlases, copied beside the binary), so
// each caller names the files that identify the root it needs.
fs::path findAssets(std::initializer_list<const char*> markers) {
    std::vector<fs::path> roots;
    std::error_code error;
    roots.push_back(fs::current_path(error));
#ifdef __linux__
    const auto executable = fs::read_symlink("/proc/self/exe", error);
    if (!error) roots.push_back(executable.parent_path());
#endif
    for (const auto& root : roots) {
        auto cursor = root;
        for (int level = 0; level < 6 && !cursor.empty(); ++level) {
            const auto candidate = cursor / "assets";
            for (const char* marker : markers) {
                if (fs::is_regular_file(candidate / marker, error)) return candidate;
            }
            const auto parent = cursor.parent_path();
            if (parent == cursor) break;
            cursor = parent;
        }
    }
    return {};
}

struct IconPixel {
    unsigned char red = 0;
    unsigned char green = 0;
    unsigned char blue = 0;
    unsigned char alpha = 0;
};

bool insidePolygon(float x, float y, std::span<const ImVec2> polygon) {
    bool inside = false;
    for (std::size_t i = 0, previous = polygon.size() - 1; i < polygon.size(); previous = i++) {
        const auto& a = polygon[i];
        const auto& b = polygon[previous];
        if (((a.y > y) != (b.y > y)) &&
            x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) {
            inside = !inside;
        }
    }
    return inside;
}

void fillPolygon(std::vector<IconPixel>& pixels, int size, std::span<const ImVec2> polygon,
                 IconPixel color) {
    for (int y = 0; y < size; ++y) {
        for (int x = 0; x < size; ++x) {
            if (insidePolygon(static_cast<float>(x) + 0.5F, static_cast<float>(y) + 0.5F,
                              polygon)) {
                pixels[static_cast<std::size_t>(y * size + x)] = color;
            }
        }
    }
}

void setProductIcon(GLFWwindow* window, const fs::path& assets) {
    std::error_code error;
    if (assets.empty() ||
        (!fs::is_regular_file(assets / "logo_icon.png", error) &&
         !fs::is_regular_file(assets / "make_logo.py", error))) {
        return;
    }

    // This is the canonical generator's native 32 px tier. Keeping the tiny rasterizer here
    // avoids adding a second image library merely to hand GLFW an RGBA window icon.
    constexpr int size = 32;
    std::vector<IconPixel> pixels(static_cast<std::size_t>(size * size));
    for (int y = 0; y < size; ++y) {
        const float mix = static_cast<float>(y) / static_cast<float>(size - 1);
        const auto channel = [mix](int top, int bottom) {
            return static_cast<unsigned char>(std::lround(top + (bottom - top) * mix));
        };
        for (int x = 0; x < size; ++x) {
            const float dx = std::max(7.5F - static_cast<float>(x),
                                      static_cast<float>(x) - (size - 1 - 7.5F));
            const float dy = std::max(7.5F - static_cast<float>(y),
                                      static_cast<float>(y) - (size - 1 - 7.5F));
            const bool outsideCorner = dx > 0.0F && dy > 0.0F && dx * dx + dy * dy > 56.25F;
            pixels[static_cast<std::size_t>(y * size + x)] =
                IconPixel{channel(0x1E, 0x0E), channel(0x22, 0x10), channel(0x2C, 0x16),
                          static_cast<unsigned char>(outsideCorner ? 0 : 255)};
        }
    }

    const float center = 16.0F;
    const float radius = 12.32F;
    const auto point = [=](float x, float y) { return ImVec2(center + x * radius, center + y * radius); };
    const std::array<ImVec2, 6> left = {point(-0.78F, 0.0F), point(-0.46F, -0.58F),
                                        point(-0.20F, -0.58F), point(-0.50F, 0.0F),
                                        point(-0.20F, 0.58F), point(-0.46F, 0.58F)};
    std::array<ImVec2, 6> right{};
    for (std::size_t i = 0; i < left.size(); ++i) right[i] = ImVec2(size - left[i].x, left[i].y);
    fillPolygon(pixels, size, left, IconPixel{0x22, 0xBE, 0xAA, 255});
    fillPolygon(pixels, size, right, IconPixel{0x10, 0x80, 0x73, 255});
    const std::array<ImVec2, 4> leftHighlight = {left[0], left[1], left[2], left[3]};
    const std::array<ImVec2, 4> rightHighlight = {right[0], right[1], right[2], right[3]};
    fillPolygon(pixels, size, leftHighlight, IconPixel{0x42, 0xEC, 0xCE, 255});
    fillPolygon(pixels, size, rightHighlight, IconPixel{0x30, 0xD8, 0xBE, 255});

    GLFWimage image{size, size, reinterpret_cast<unsigned char*>(pixels.data())};
    glfwSetWindowIcon(window, 1, &image);
}

std::string encodeBase64(std::span<const std::uint8_t> bytes) {
    static constexpr char alphabet[] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string output;
    output.reserve((bytes.size() + 2U) / 3U * 4U);
    for (std::size_t index = 0; index < bytes.size(); index += 3U) {
        const std::uint32_t a = bytes[index];
        const std::uint32_t b = index + 1U < bytes.size() ? bytes[index + 1U] : 0U;
        const std::uint32_t c = index + 2U < bytes.size() ? bytes[index + 2U] : 0U;
        const std::uint32_t packed = (a << 16U) | (b << 8U) | c;
        output.push_back(alphabet[(packed >> 18U) & 63U]);
        output.push_back(alphabet[(packed >> 12U) & 63U]);
        output.push_back(index + 1U < bytes.size() ? alphabet[(packed >> 6U) & 63U] : '=');
        output.push_back(index + 2U < bytes.size() ? alphabet[packed & 63U] : '=');
    }
    return output;
}

void appendBigEndian(std::vector<std::uint8_t>& output, std::uint32_t value) {
    output.push_back(static_cast<std::uint8_t>((value >> 24U) & 0xFFU));
    output.push_back(static_cast<std::uint8_t>((value >> 16U) & 0xFFU));
    output.push_back(static_cast<std::uint8_t>((value >> 8U) & 0xFFU));
    output.push_back(static_cast<std::uint8_t>(value & 0xFFU));
}

std::uint32_t crc32(std::span<const std::uint8_t> bytes) {
    std::uint32_t crc = 0xFFFFFFFFU;
    for (const auto byte : bytes) {
        crc ^= byte;
        for (int bit = 0; bit < 8; ++bit) {
            crc = (crc >> 1U) ^ (0xEDB88320U & (0U - (crc & 1U)));
        }
    }
    return ~crc;
}

std::uint32_t adler32(std::span<const std::uint8_t> bytes) {
    std::uint32_t first = 1;
    std::uint32_t second = 0;
    for (const auto byte : bytes) {
        first = (first + byte) % 65521U;
        second = (second + first) % 65521U;
    }
    return (second << 16U) | first;
}

void appendPngChunk(std::vector<std::uint8_t>& output, std::string_view type,
                    std::span<const std::uint8_t> payload) {
    appendBigEndian(output, static_cast<std::uint32_t>(payload.size()));
    const auto crcStart = output.size();
    output.insert(output.end(), type.begin(), type.end());
    output.insert(output.end(), payload.begin(), payload.end());
    appendBigEndian(output, crc32(std::span<const std::uint8_t>(output).subspan(crcStart)));
}

void writePng(const fs::path& path, int width, int height, std::span<const std::uint8_t> rgba) {
    std::vector<std::uint8_t> filtered;
    filtered.reserve(static_cast<std::size_t>((width * 4 + 1) * height));
    for (int y = height - 1; y >= 0; --y) {
        filtered.push_back(0);
        const auto offset = static_cast<std::size_t>(y * width * 4);
        filtered.insert(filtered.end(), rgba.begin() + static_cast<std::ptrdiff_t>(offset),
                        rgba.begin() + static_cast<std::ptrdiff_t>(offset + width * 4));
    }

    std::vector<std::uint8_t> compressed{0x78, 0x01};
    for (std::size_t offset = 0; offset < filtered.size();) {
        const auto length = static_cast<std::uint16_t>(
            std::min<std::size_t>(65535U, filtered.size() - offset));
        const bool final = offset + length == filtered.size();
        compressed.push_back(final ? 0x01 : 0x00);
        compressed.push_back(static_cast<std::uint8_t>(length & 0xFFU));
        compressed.push_back(static_cast<std::uint8_t>(length >> 8U));
        const auto inverted = static_cast<std::uint16_t>(~length);
        compressed.push_back(static_cast<std::uint8_t>(inverted & 0xFFU));
        compressed.push_back(static_cast<std::uint8_t>(inverted >> 8U));
        compressed.insert(compressed.end(), filtered.begin() + static_cast<std::ptrdiff_t>(offset),
                          filtered.begin() + static_cast<std::ptrdiff_t>(offset + length));
        offset += length;
    }
    appendBigEndian(compressed, adler32(filtered));

    std::vector<std::uint8_t> png{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A};
    std::vector<std::uint8_t> header;
    appendBigEndian(header, static_cast<std::uint32_t>(width));
    appendBigEndian(header, static_cast<std::uint32_t>(height));
    header.insert(header.end(), {8, 6, 0, 0, 0});
    appendPngChunk(png, "IHDR", header);
    appendPngChunk(png, "IDAT", compressed);
    appendPngChunk(png, "IEND", {});

    if (!path.parent_path().empty()) fs::create_directories(path.parent_path());
    std::ofstream stream(path, std::ios::binary);
    stream.write(reinterpret_cast<const char*>(png.data()), static_cast<std::streamsize>(png.size()));
    if (!stream) throw std::runtime_error("failed to write screenshot");
}

void writePpm(const fs::path& path, int width, int height, std::span<const std::uint8_t> rgba) {
    if (!path.parent_path().empty()) fs::create_directories(path.parent_path());
    std::ofstream stream(path, std::ios::binary);
    stream << "P6\n" << width << ' ' << height << "\n255\n";
    for (int y = height - 1; y >= 0; --y) {
        for (int x = 0; x < width; ++x) {
            const auto offset = static_cast<std::size_t>((y * width + x) * 4);
            stream.write(reinterpret_cast<const char*>(rgba.data() + offset), 3);
        }
    }
    if (!stream) throw std::runtime_error("failed to write screenshot");
}

void captureScreenshot(const fs::path& path, int width, int height) {
    std::vector<std::uint8_t> rgba(static_cast<std::size_t>(width * height * 4));
    glPixelStorei(GL_PACK_ALIGNMENT, 1);
    glReadBuffer(GL_BACK);
    glReadPixels(0, 0, width, height, GL_RGBA, GL_UNSIGNED_BYTE, rgba.data());
    auto extension = path.extension().string();
    std::transform(extension.begin(), extension.end(), extension.begin(), [](unsigned char character) {
        return static_cast<char>(std::tolower(character));
    });
    if (extension == ".png") writePng(path, width, height, rgba);
    else writePpm(path, width, height, rgba);
}

std::optional<std::vector<DesktopSessionTab>> parseTabs(const ResponseFrame& response) {
    if (response.error || !response.result) return std::nullopt;
    try {
        std::vector<DesktopSessionTab> tabs;
        for (const auto& item : response.result->at("tabs")) {
            tabs.push_back(DesktopSessionTab{item.at("path").get<std::string>(),
                                             item.at("title").get<std::string>(),
                                             item.at("cwd").get<std::string>(),
                                             item.at("active").get<bool>(),
                                             item.at("running").get<bool>(),
                                             item.at("unread").get<std::int64_t>(),
                                             item.at("draftDirty").get<bool>()});
        }
        return tabs;
    } catch (const nlohmann::json::exception&) {
        return std::nullopt;
    }
}

enum class ConnectionState { Connecting, Negotiating, Ready, Blocked };
enum class Activity { Explorer, Search, SourceControl, Terminal, Graph, Sessions };

std::string_view activityLabel(Activity activity) {
    switch (activity) {
        case Activity::Explorer: return "Explorer";
        case Activity::Search: return "Search";
        case Activity::SourceControl: return "Source Control";
        case Activity::Terminal: return "Terminal";
        case Activity::Graph: return "Graph";
        case Activity::Sessions: return "Sessions";
    }
    return {};
}

bool hasSidePanel(Activity activity) {
    return activity == Activity::Explorer || activity == Activity::Search ||
           activity == Activity::SourceControl || activity == Activity::Sessions;
}

constexpr std::array kActivities = {
    Activity::Explorer, Activity::Search, Activity::SourceControl,
    Activity::Terminal, Activity::Graph, Activity::Sessions,
};

/// Width the rail needs for its widest label to render in full.
///
/// ImGui::Button clips its label to the button rect, so a rail sized by a magic
/// constant silently truncates ("Explorer" -> "Explore", "Source Control" ->
/// "Source") at the default font and truncates differently at every DPI scale.
/// Measuring the text keeps every label intact at any scale.
float activityRailWidth() {
    float widest = 0.0F;
    for (const auto activity : kActivities) {
        const auto label = activityLabel(activity);
        widest = std::max(widest, ImGui::CalcTextSize(label.data(), label.data() + label.size()).x);
    }
    const auto& style = ImGui::GetStyle();
    return widest + (style.FramePadding.x + style.WindowPadding.x + style.ChildBorderSize) * 2.0F;
}

void drawActivityRail(Activity& selected, terminal::TerminalView& terminalView,
                      workspace::WorkspaceView& workspaceView, bool& focusSidePanel) {
    ImGui::PushStyleVar(ImGuiStyleVar_FrameRounding, 3.0F);
    for (const auto activity : kActivities) {
        const bool active = selected == activity;
        if (active) {
            ImGui::PushStyleColor(ImGuiCol_Button, ui::palette().accentSoft);
            ImGui::PushStyleColor(ImGuiCol_Text, ui::palette().accent);
        }
        const auto label = activityLabel(activity);
        if (ImGui::Button(label.data(), ImVec2(-1.0F, ui::metrics::px(34.0F)))) {
            selected = activity;
            focusSidePanel = hasSidePanel(activity);
            if (activity == Activity::Terminal) terminalView.requestFocus();
            if (activity == Activity::Search) workspaceView.quickOpen();
        }
        if (active) ImGui::PopStyleColor(2);
    }
    ImGui::PopStyleVar();
}

void drawSessionList(copilot::CopilotView& copilotView) {
    const auto tabs = copilotView.sessionTabs();
    if (tabs.empty()) {
        (void)kit::emptyState("No sessions", "Start a session from a project to see it here.");
        return;
    }
    for (const auto& tab : tabs) {
        // tab.title is the server's raw session id when a session was never
        // named, so show a readable stamp for those and the chosen name verbatim.
        const std::string shown = copilot::sessionStamp(tab.title).value_or(tab.title);
        const std::string label =
            kit::elide(shown, ImGui::GetContentRegionAvail().x) + "##session-list-" + tab.path;
        if (ImGui::Selectable(label.c_str(), tab.active)) copilotView.switchSession(tab.path);
        if (ImGui::IsItemHovered() && shown != tab.title) ImGui::SetTooltip("%s", tab.title.c_str());
        if (tab.running || tab.unread > 0 || tab.draftDirty) {
            ImGui::SameLine();
            std::string state;
            if (tab.running) state += "running";
            if (tab.unread > 0) state += (state.empty() ? "" : " | ") + std::to_string(tab.unread) + " new";
            if (tab.draftDirty) state += (state.empty() ? "" : " | ") + std::string("draft");
            kit::dimText(state.c_str());
        }
    }
}

void drawSessionTabs(copilot::CopilotView& copilotView) {
    const auto tabs = copilotView.sessionTabs();
    if (tabs.empty()) {
        kit::dimText("No sessions");
        return;
    }
    ImGui::PushStyleVar(ImGuiStyleVar_ItemSpacing, ImVec2(3.0F, 4.0F));
    for (std::size_t index = 0; index < tabs.size(); ++index) {
        if (index != 0) ImGui::SameLine();
        const auto& tab = tabs[index];
        std::string label = tab.running ? "Run " : "";
        label += tab.title.empty() ? "Session" : copilot::sessionStamp(tab.title).value_or(tab.title);
        if (tab.unread > 0) label += " (" + std::to_string(tab.unread) + ")";
        if (tab.draftDirty) label += " *";
        label += "##global-session-" + tab.path;
        if (tab.active) {
            ImGui::PushStyleColor(ImGuiCol_Button, ui::palette().tabActive);
            ImGui::PushStyleColor(ImGuiCol_Text, ui::palette().text);
        }
        if (ImGui::Button(label.c_str())) copilotView.switchSession(tab.path);
        if (tab.active) ImGui::PopStyleColor(2);
    }
    ImGui::PopStyleVar();
}

void routeShortcuts(Activity& activity, copilot::CopilotView& copilotView,
                    workspace::WorkspaceView& workspaceView,
                    terminal::TerminalView& terminalView, bool& focusSidePanel,
                    double& projectChordUntil) {
    const auto& io = ImGui::GetIO();
    if (io.WantTextInput) return;

    const auto focus = [&](Activity target) {
        activity = target;
        focusSidePanel = hasSidePanel(target);
        if (target == Activity::Terminal) terminalView.requestFocus();
        if (target == Activity::Search) workspaceView.quickOpen();
    };
    if (ImGui::IsKeyChordPressed(ImGuiMod_Shortcut | ImGuiMod_Shift | ImGuiKey_E)) focus(Activity::Explorer);
    if (ImGui::IsKeyChordPressed(ImGuiMod_Shortcut | ImGuiMod_Shift | ImGuiKey_F)) focus(Activity::Search);
    if (ImGui::IsKeyChordPressed(ImGuiMod_Shortcut | ImGuiMod_Shift | ImGuiKey_G)) focus(Activity::SourceControl);
    if (ImGui::IsKeyChordPressed(ImGuiMod_Shortcut | ImGuiKey_GraveAccent)) focus(Activity::Terminal);

    const auto tabs = copilotView.sessionTabs();
    static constexpr std::array numberKeys = {
        ImGuiKey_1, ImGuiKey_2, ImGuiKey_3, ImGuiKey_4, ImGuiKey_5,
        ImGuiKey_6, ImGuiKey_7, ImGuiKey_8, ImGuiKey_9,
    };
    for (std::size_t index = 0; index < numberKeys.size() && index < tabs.size(); ++index) {
        if (ImGui::IsKeyChordPressed(ImGuiMod_Shortcut | numberKeys[index])) {
            copilotView.switchSession(tabs[index].path);
        }
    }
    if (!tabs.empty() && ImGui::IsKeyChordPressed(ImGuiMod_Shortcut | ImGuiKey_Tab)) {
        auto current = std::find_if(tabs.begin(), tabs.end(), [](const auto& tab) { return tab.active; });
        const std::size_t index = current == tabs.end()
                                      ? 0U
                                      : (static_cast<std::size_t>(current - tabs.begin()) + 1U) % tabs.size();
        copilotView.switchSession(tabs[index].path);
    }

    const double now = ImGui::GetTime();
    if (ImGui::IsKeyChordPressed(ImGuiMod_Shortcut | ImGuiKey_K)) projectChordUntil = now + 1.25;
    if (projectChordUntil >= now &&
        (ImGui::IsKeyPressed(ImGuiKey_P) ||
         ImGui::IsKeyChordPressed(ImGuiMod_Shortcut | ImGuiKey_P))) {
        workspaceView.requestOpenFolder();
        projectChordUntil = 0.0;
    }
}

struct GlfwLifetime {
    ~GlfwLifetime() { glfwTerminate(); }
};

struct WindowLifetime {
    GLFWwindow* window = nullptr;
    ~WindowLifetime() {
        if (window != nullptr) glfwDestroyWindow(window);
    }
};

struct ImGuiLifetime {
    bool glfwBackend = false;
    bool openGlBackend = false;
    ~ImGuiLifetime() {
        if (openGlBackend) ImGui_ImplOpenGL3_Shutdown();
        if (glfwBackend) ImGui_ImplGlfw_Shutdown();
        if (ImGui::GetCurrentContext() != nullptr) ImGui::DestroyContext();
    }
};

// The icon loader owns both theme atlas textures; this guard releases them
// while the GL context is still alive (declared after WindowLifetime, so it
// destructs first).
struct IconAtlasLifetime {
    ~IconAtlasLifetime() { icons::unloadIcons(); }
};

#ifndef GL_CLAMP_TO_EDGE
#define GL_CLAMP_TO_EDGE 0x812F
#endif

// RGBA8 texture upload/destroy against the app's live GL context. Shared by
// the icon atlas loader and the copilot attachment-thumbnail cache; both own
// (and provably release) every texture they create through it.
icons::TextureBackend makeGlTextureBackend() {
    return {
        [](const unsigned char* rgba, int width, int height) -> ImTextureID {
            GLuint texture = 0;
            glGenTextures(1, &texture);
            if (texture == 0) return 0;
            GLint previous = 0;
            glGetIntegerv(GL_TEXTURE_BINDING_2D, &previous);
            glBindTexture(GL_TEXTURE_2D, texture);
            glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
            glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, width, height, 0, GL_RGBA,
                         GL_UNSIGNED_BYTE, rgba);
            glBindTexture(GL_TEXTURE_2D, static_cast<GLuint>(previous));
            return static_cast<ImTextureID>(texture);
        },
        [](ImTextureID texture) {
            const auto id = static_cast<GLuint>(texture);
            glDeleteTextures(1, &id);
        },
    };
}

}  // namespace

const char* usage() noexcept {
    return "Usage: chudcode-gui --url <ws://loopback:port> --token <bearer> [options]\n"
           "  --screenshot <file.ppm|file.png>  Capture once connected and settled\n"
           "  --width <pixels>                  Window width (minimum 800)\n"
           "  --project <path>                   Open this project after connecting\n"
           "  --frames <count>                  Bound rendering/capture frames\n"
           "  --reduced-motion                  Disable nonessential motion\n"
           "  --accessible-lists                Prefer keyboard-readable graph lists\n";
}

AppOptions parseOptions(int argc, const char* const* argv) {
    AppOptions options;
    options.url = environment("CHUDCODE_DESKTOP_URL");
    options.token = environment("CHUDCODE_DESKTOP_TOKEN");
    options.projectPath = environment("CHUDCODE_PROJECT");
    options.reducedMotion = environmentEnabled("CHUDCODE_REDUCED_MOTION");
    options.accessibleLists = environmentEnabled("CHUDCODE_ACCESSIBLE_LISTS");

    for (int index = 1; index < argc; ++index) {
        const std::string_view argument(argv[index]);
        if (argument == "--url" || argument.starts_with("--url=")) {
            options.url = optionValue(index, argc, argv, "--url");
        } else if (argument == "--token" || argument.starts_with("--token=")) {
            options.token = optionValue(index, argc, argv, "--token");
        } else if (argument == "--project" || argument.starts_with("--project=")) {
            options.projectPath = optionValue(index, argc, argv, "--project");
        } else if (argument == "--screenshot" || argument.starts_with("--screenshot=")) {
            options.screenshotPath = std::string(optionValue(index, argc, argv, "--screenshot"));
        } else if (argument == "--width" || argument.starts_with("--width=")) {
            options.width = static_cast<int>(parsePositive(optionValue(index, argc, argv, "--width"),
                                                           "--width", 8192));
        } else if (argument == "--height" || argument.starts_with("--height=")) {
            options.height = static_cast<int>(parsePositive(optionValue(index, argc, argv, "--height"),
                                                            "--height", 8192));
        } else if (argument == "--frames" || argument.starts_with("--frames=")) {
            options.frameLimit = parsePositive(optionValue(index, argc, argv, "--frames"),
                                               "--frames", 1'000'000);
        } else if (argument == "--reduced-motion") {
            options.reducedMotion = true;
        } else if (argument == "--accessible-lists") {
            options.accessibleLists = true;
        } else if (argument == "--help" || argument == "-h") {
            throw UsageError("help requested");
        } else {
            throw UsageError("unknown option: " + safeOptionName(argument));
        }
    }

    if (options.width < kMinimumWidth) throw UsageError("--width must be at least 800");
    if (options.height < kMinimumHeight) throw UsageError("--height must be at least 560");
    if (options.url.empty()) throw UsageError("--url is required (or set CHUDCODE_DESKTOP_URL)");
    if (options.token.empty()) throw UsageError("--token is required (or set CHUDCODE_DESKTOP_TOKEN)");
    if (options.token.find_first_of("\r\n") != std::string::npos) {
        throw UsageError("--token must not contain a line break");
    }
    if (options.screenshotPath && options.frameLimit == 0) {
        options.frameLimit = kDefaultScreenshotFrames;
    }
    return options;
}

int run(const AppOptions& options) {
    glfwSetErrorCallback([](int code, const char* description) {
        std::fprintf(stderr, "chudcode-gui: GLFW error %d: %s\n", code,
                     description != nullptr ? description : "(no description)");
    });
#if defined(GLFW_PLATFORM) && defined(GLFW_PLATFORM_X11)
    // A capture run must be deterministic, so it always uses X11/Xvfb: letting it
    // pick Wayland makes it block indefinitely against the desktop compositor, and
    // Wayland teardown has been observed to crash right after capture. Interactive
    // runs keep Wayland whenever a compositor is genuinely reachable and fall back
    // to X11 when it is not, because GLFW aborts init rather than falling back.
    if (std::getenv("DISPLAY") != nullptr && (options.screenshotPath || !waylandSocketPresent())) {
        glfwInitHint(GLFW_PLATFORM, GLFW_PLATFORM_X11);
    }
#endif
    if (glfwInit() != GLFW_TRUE) throw std::runtime_error("GLFW initialization failed");
    GlfwLifetime glfwLifetime;

    glfwWindowHint(GLFW_CONTEXT_VERSION_MAJOR, 3);
    glfwWindowHint(GLFW_CONTEXT_VERSION_MINOR, 3);
    glfwWindowHint(GLFW_OPENGL_PROFILE, GLFW_OPENGL_CORE_PROFILE);
#ifdef __APPLE__
    glfwWindowHint(GLFW_OPENGL_FORWARD_COMPAT, GLFW_TRUE);
#endif
#ifdef GLFW_X11_CLASS_NAME
    glfwWindowHintString(GLFW_X11_CLASS_NAME, "chudcode");
    glfwWindowHintString(GLFW_X11_INSTANCE_NAME, "chudcode");
#endif
#ifdef GLFW_WAYLAND_APP_ID
    glfwWindowHintString(GLFW_WAYLAND_APP_ID, "chudcode");
#endif

    WindowLifetime window{glfwCreateWindow(options.width, options.height, "Chudcode", nullptr, nullptr)};
    if (window.window == nullptr) throw std::runtime_error("window creation failed");
    glfwSetWindowSizeLimits(window.window, kMinimumWidth, kMinimumHeight, GLFW_DONT_CARE,
                            GLFW_DONT_CARE);
    glfwMakeContextCurrent(window.window);
    glfwSwapInterval(1);

    // Brand assets (window icon sources) live at the repo root; runtime UI
    // assets (fonts, icon atlases) are the gui/assets tree copied beside the
    // binary. Different roots, so they are located independently.
    setProductIcon(window.window, findAssets({"logo_icon.png", "make_logo.py"}));
    const auto assets = findAssets({"icons/atlas.json", "fonts/Rubik-Regular.ttf"});

    IMGUI_CHECKVERSION();
    // Dear ImGui stores this pointer instead of copying the string, and its
    // teardown save (ImGui::DestroyContext -> Shutdown -> SaveIniSettingsToDisk)
    // runs from ~ImGuiLifetime. Declaring the path first makes it outlive that
    // guard; declared after, the shutdown save read freed memory and wrote the
    // window layout to a garbage filename in the working directory.
    const std::string iniPath = (dataDirectory() / "imgui.ini").string();
    ImGui::CreateContext();
    ImGuiLifetime imguiLifetime;
    auto& io = ImGui::GetIO();
    io.ConfigFlags |= ImGuiConfigFlags_NavEnableKeyboard | ImGuiConfigFlags_DockingEnable;
    io.IniFilename = iniPath.c_str();
    io.LogFilename = nullptr;

    float xScale = 1.0F;
    float yScale = 1.0F;
    glfwGetWindowContentScale(window.window, &xScale, &yScale);
    const float scale = std::clamp(std::max(xScale, yScale), 0.75F, 2.5F);
    io.Fonts->AddFontDefault();
    if (!assets.empty()) (void)ui::loadFonts(assets.string().c_str(), scale);
    ui::applyTheme(ui::Theme::Dark, scale);
    anim::setMotionScale(options.reducedMotion ? 0.0F : 1.0F);

    if (!ImGui_ImplGlfw_InitForOpenGL(window.window, true)) {
        throw std::runtime_error("Dear ImGui GLFW backend initialization failed");
    }
    imguiLifetime.glfwBackend = true;
    if (!ImGui_ImplOpenGL3_Init("#version 330")) {
        throw std::runtime_error("Dear ImGui OpenGL backend initialization failed");
    }
    imguiLifetime.openGlBackend = true;

    // Icon atlas: uploaded through the injected GL backend, released by the
    // guard while the context is still current. A load failure is survivable —
    // icon-backed controls fall back to their full text labels — but is
    // reported, because a missing atlas is an install problem worth fixing.
    IconAtlasLifetime iconAtlasLifetime;
    if (!assets.empty()) {
        std::string iconError;
        if (!icons::loadIcons(assets.string(), makeGlTextureBackend(), &iconError)) {
            std::fprintf(stderr, "chudcode-gui: icon atlas unavailable: %s\n",
                         iconError.c_str());
        }
        icons::setIconTheme(ui::Theme::Dark);
    } else {
        std::fprintf(stderr,
                     "chudcode-gui: assets directory not found; controls use text labels\n");
    }

    WsTransport transport(WsTransportConfig{options.url, options.token});
    DesktopStore store;
    DesktopClient client(transport, store);
    editor::EditorPanel editor(editor::EditorRequests::forProtocolClient(client));
    workspace::WorkspaceView workspaceView(client, store, editor);
    GraphView graphView;
    graphView.setAccessibleFallback(options.accessibleLists);
    graphView.setOpenSourceCallback([&editor](const SourceLocation& location) { editor.open(location.uri); });
    session_graph::SessionDagView sessionDagView;
    vcs::VcsView vcsView(client, graphView);
    copilot::CopilotView copilotView(
        store, copilot::CopilotActions{[&client](std::string method, Json params,
                                                copilot::CopilotActions::Response response) {
            (void)client.request(std::move(method), std::move(params), std::move(response));
        }});
    // Draft-attachment thumbnails share the icon backend; the cache owns its
    // textures and CopilotView is destroyed before the GL context.
    copilotView.setImageBackend(makeGlTextureBackend());
    // Borrowed pointer to the DAG the app re-syncs each frame; supplies the
    // agents drawer's grouping/orphan/recoverable state.
    copilotView.setSessionDag(&sessionDagView.dag());

    terminal::TerminalModels terminalModels(terminal::TerminalProtocolCallbacks{
        [&client](std::string_view terminalId, std::span<const std::uint8_t> bytes) {
            (void)client.request("terminal.write",
                                 Json{{"terminalId", terminalId}, {"data", encodeBase64(bytes)}});
        },
        [&client](std::string_view terminalId, int columns, int rows) {
            (void)client.request("terminal.resize",
                                 Json{{"terminalId", terminalId}, {"cols", columns}, {"rows", rows}});
        },
        [&client](std::string_view terminalId) {
            (void)client.request("terminal.close", Json{{"terminalId", terminalId}});
        },
    });
    terminal::TerminalView terminalView;

    std::unordered_map<std::string, std::string> terminalByWorkspace;
    std::unordered_set<std::string> terminalPending;
    std::string activeWorkspace;
    std::map<GraphKind, std::int64_t> graphRevisions;

    client.setEventHandler([&](const EventFrame& frame) {
        std::visit(
            [&](const auto& event) {
                using Event = std::decay_t<decltype(event)>;
                if constexpr (std::is_same_v<Event, TerminalDataEvent>) {
                    terminalModels.enqueueDataBase64(event.terminalId, event.dataBase64);
                } else if constexpr (std::is_same_v<Event, TerminalExitEvent>) {
                    terminalModels.enqueueExit(event.terminalId,
                                               event.exitCode ? std::optional<int>(static_cast<int>(*event.exitCode))
                                                              : std::nullopt,
                                               event.signal.value_or(std::string{}));
                } else if constexpr (std::is_same_v<Event, WorkspaceChangeEvent>) {
                    workspaceView.applyChanges(event.workspaceId, event.changes);
                } else if constexpr (std::is_same_v<Event, GraphEvent>) {
                    if (event.workspaceId == graphView.workspace()) graphView.update(event.kind, event.graph);
                }
            },
            frame.payload);
    });

    auto ensureTerminal = [&] {
        if (activeWorkspace.empty() || terminalByWorkspace.contains(activeWorkspace) ||
            terminalPending.contains(activeWorkspace)) {
            return;
        }
        const std::string workspaceId = activeWorkspace;
        terminalPending.insert(workspaceId);
        (void)client.request(
            "terminal.create", Json{{"workspaceId", workspaceId}, {"cols", 100}, {"rows", 24}},
            [&, workspaceId](const ResponseFrame& response) {
                terminalPending.erase(workspaceId);
                if (response.error || !response.result) return;
                try {
                    const auto terminalId = response.result->at("terminalId").get<std::string>();
                    if (terminalModels.find(terminalId) == nullptr) {
                        terminalModels.create(terminalId, workspaceId, 100, 24);
                    }
                    terminalByWorkspace[workspaceId] = terminalId;
                } catch (const nlohmann::json::exception&) {
                    return;
                }
            });
    };

    int bootstrapGeneration = 0;
    int bootstrapOutstanding = 0;
    ConnectionState connectionState = ConnectionState::Connecting;
    std::string blockedReason;
    auto bootstrap = [&] {
        const int generation = ++bootstrapGeneration;
        bootstrapOutstanding = 1;
        connectionState = ConnectionState::Negotiating;
        blockedReason.clear();
        (void)client.request(
            "runtime.hello", Json{{"protocol", kDesktopProtocolVersion}},
            [&, generation](const ResponseFrame& response) {
                if (generation != bootstrapGeneration) return;
                bootstrapOutstanding = 0;
                if (response.error || !response.result) {
                    connectionState = ConnectionState::Blocked;
                    blockedReason = response.error ? response.error->message : "runtime.hello returned no result";
                    return;
                }
                try {
                    const int protocol = response.result->at("protocol").get<int>();
                    const auto product = response.result->at("product").get<std::string>();
                    if (protocol != kDesktopProtocolVersion || product != kProduct) {
                        connectionState = ConnectionState::Blocked;
                        blockedReason = "The Chudcode desktop service uses an incompatible protocol.";
                        return;
                    }
                } catch (const nlohmann::json::exception&) {
                    connectionState = ConnectionState::Blocked;
                    blockedReason = "runtime.hello returned a malformed identity.";
                    return;
                }
                connectionState = ConnectionState::Ready;
                bootstrapOutstanding = 1;
                (void)client.request("session.tabs", Json::object(), [&, generation](const ResponseFrame& tabsResponse) {
                    if (generation != bootstrapGeneration) return;
                    --bootstrapOutstanding;
                    if (auto tabs = parseTabs(tabsResponse)) {
                        store.apply(EventFrame{SessionTabsEvent{std::move(*tabs)}});
                        if (store.activeSessionPath()) copilotView.setSessionPath(*store.activeSessionPath());
                        else if (!store.tabs().empty()) copilotView.setSessionPath(store.tabs().front().path);
                    }
                });
                workspaceView.refreshRecent();
                if (!options.projectPath.empty()) workspaceView.openProject(options.projectPath);
            });
    };

    client.start();
    bool wasConnected = false;
    Activity activity = Activity::Explorer;
    bool focusSidePanel = false;
    double projectChordUntil = 0.0;
    std::uint64_t renderedFrames = 0;
    std::uint64_t settledFrames = 0;
    bool screenshotWritten = false;

    while (glfwWindowShouldClose(window.window) == GLFW_FALSE) {
        glfwPollEvents();
        client.drain();
        (void)terminalModels.processPending();
        workspaceView.syncFromStore();

        const bool connected = transport.connected();
        if (connected && !wasConnected) bootstrap();
        if (!connected && wasConnected) {
            ++bootstrapGeneration;
            bootstrapOutstanding = 0;
            connectionState = ConnectionState::Connecting;
            blockedReason.clear();
        }
        wasConnected = connected;

        if (const auto* descriptor = workspaceView.currentWorkspace();
            descriptor != nullptr && descriptor->id != activeWorkspace) {
            activeWorkspace = descriptor->id;
            editor.setWorkspace(activeWorkspace);
            graphView.setWorkspace(activeWorkspace);
            vcsView.setWorkspace(activeWorkspace);
            graphRevisions.clear();
            (void)client.request("git.snapshot", Json{{"workspaceId", activeWorkspace}});
            for (const auto kind : {"code", "git", "agent"}) {
                (void)client.request("graph.snapshot",
                                     Json{{"workspaceId", activeWorkspace}, {"kind", kind}});
            }
            ensureTerminal();
        }
        if (!activeWorkspace.empty()) {
            if (const auto* snapshot = store.workspace(activeWorkspace)) {
                vcsView.sync(snapshot->git);
                for (const auto& [kind, graph] : snapshot->graphs) {
                    const auto revision = graphRevisions.find(kind);
                    if (revision == graphRevisions.end() || revision->second != graph.revision) {
                        graphView.update(kind, graph);
                        graphRevisions[kind] = graph.revision;
                    }
                }
            }
        }

        if (store.activeSessionPath() && copilotView.sessionPath() != *store.activeSessionPath()) {
            copilotView.setSessionPath(*store.activeSessionPath());
        }
        sessionDagView.sync(
            copilotView.sessionPath(), store.session(copilotView.sessionPath()),
            copilotView.projection());

        ImGui_ImplOpenGL3_NewFrame();
        ImGui_ImplGlfw_NewFrame();
        ImGui::NewFrame();
        routeShortcuts(activity, copilotView, workspaceView, terminalView, focusSidePanel,
                       projectChordUntil);

        editor.processCallbacks();
        const float delta = anim::dt(io.DeltaTime);
        editor.advanceAnimations(delta);
        if (activity != Activity::Explorer && activity != Activity::Search) {
            workspaceView.advanceAnimations(delta);
        }
        if (activity != Activity::SourceControl) vcsView.advanceAnimations(delta);
        graphView.tick(delta);

        const ImGuiViewport* viewport = ImGui::GetMainViewport();
        ImGui::SetNextWindowPos(viewport->WorkPos);
        ImGui::SetNextWindowSize(viewport->WorkSize);
        ImGui::SetNextWindowViewport(viewport->ID);
        ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding, ImVec2(0.0F, 0.0F));
        ImGui::PushStyleVar(ImGuiStyleVar_WindowRounding, 0.0F);
        ImGui::PushStyleVar(ImGuiStyleVar_WindowBorderSize, 0.0F);
        constexpr ImGuiWindowFlags shellFlags =
            ImGuiWindowFlags_NoDecoration | ImGuiWindowFlags_NoMove | ImGuiWindowFlags_NoSavedSettings |
            ImGuiWindowFlags_NoBringToFrontOnFocus | ImGuiWindowFlags_NoNavFocus;
        ImGui::Begin("Chudcode##shell", nullptr, shellFlags);
        ImGui::PopStyleVar(3);

        // Every bar in this stack hosts one row of framed widgets, so its height
        // follows the font rather than a constant: a short child gives itself a
        // scrollbar instead of showing its content.
        const auto& shellStyle = ImGui::GetStyle();
        const float barChrome = (shellStyle.WindowPadding.y + shellStyle.ChildBorderSize) * 2.0F;
        const float projectHeight = ImGui::GetFrameHeight() + barChrome;
        const float sessionHeight = projectHeight;
        const float statusHeight = ImGui::GetTextLineHeight() + barChrome;
        // The four children stack vertically, so ImGui inserts ItemSpacing.y
        // between them. Leaving those three gaps out of the budget overflowed the
        // shell and crushed the status bar (the last child) to a few dead pixels.
        const float stackGaps = shellStyle.ItemSpacing.y * 3.0F;
        const float bodyHeight =
            std::max(1.0F, ImGui::GetContentRegionAvail().y - projectHeight - sessionHeight -
                               statusHeight - stackGaps);

        ImGui::PushStyleColor(ImGuiCol_ChildBg, ui::palette().headerBg);
        ImGui::BeginChild("##project-switcher", ImVec2(0.0F, projectHeight), ImGuiChildFlags_Borders);
        ImGui::AlignTextToFramePadding();
        ImGui::TextUnformatted("CHUDCODE");
        ImGui::SameLine(0.0F, shellStyle.ItemSpacing.x * 2.0F);
        workspaceView.drawProjectSwitcher();
        ImGui::EndChild();

        ImGui::BeginChild("##session-tabs", ImVec2(0.0F, sessionHeight), ImGuiChildFlags_Borders,
                          ImGuiWindowFlags_HorizontalScrollbar);
        drawSessionTabs(copilotView);
        ImGui::EndChild();
        ImGui::PopStyleColor();

        const float availableWidth = ImGui::GetContentRegionAvail().x;
        // The rail must fit its labels; the side and copilot panels are capped so a
        // wide window grows the editor rather than the chrome. The copilot panel is
        // placed with width 0 and so absorbs any rounding slack, which is why the
        // center takes an exact budget and needs no fudge factor.
        const float railWidth =
            std::min(std::max(activityRailWidth(), ui::metrics::px(96.0F)),
                     std::max(ui::metrics::px(96.0F), availableWidth * 0.22F));
        const float sideWidth = hasSidePanel(activity)
                                    ? std::min(ui::metrics::px(286.0F), availableWidth * 0.24F)
                                    : 0.0F;
        const float rightWidth =
            std::min(ui::metrics::px(430.0F), std::max(ui::metrics::px(280.0F), availableWidth * 0.26F));
        const float centerWidth =
            std::max(1.0F, availableWidth - railWidth - sideWidth - rightWidth);

        ImGui::BeginChild("##activity-rail", ImVec2(railWidth, bodyHeight), ImGuiChildFlags_Borders);
        drawActivityRail(activity, terminalView, workspaceView, focusSidePanel);
        ImGui::EndChild();
        ImGui::SameLine(0.0F, 0.0F);

        if (hasSidePanel(activity)) {
            ImGui::BeginChild("##side-panel", ImVec2(sideWidth, bodyHeight), ImGuiChildFlags_Borders);
            if (focusSidePanel) {
                ImGui::SetKeyboardFocusHere();
                focusSidePanel = false;
            }
            if (activity == Activity::Explorer || activity == Activity::Search) {
                workspaceView.draw("##workspace-view", 0.0F, 0.0F);
            } else if (activity == Activity::SourceControl) {
                if (activeWorkspace.empty()) {
                    (void)kit::emptyState("No source control", "Open a project to inspect its repository.");
                } else {
                    vcsView.draw("##vcs-view", ImVec2(0.0F, 0.0F));
                }
            } else {
                drawSessionList(copilotView);
            }
            ImGui::EndChild();
            ImGui::SameLine(0.0F, 0.0F);
        }

        ImGui::BeginChild("##center-stack", ImVec2(centerWidth, bodyHeight), ImGuiChildFlags_Borders);
        // Terminal is the one rail activity with no side panel, so selecting it
        // has to change the centre or the click reads as dead. Give the terminal
        // the stage while it is the active activity; otherwise it stays a strip.
        const float minimumPaneHeight = ui::metrics::px(100.0F);
        const float terminalHeight =
            activity == Activity::Terminal
                ? std::max(minimumPaneHeight, bodyHeight - std::max(minimumPaneHeight, bodyHeight * 0.26F))
                : std::clamp(bodyHeight * 0.29F, minimumPaneHeight,
                             std::max(minimumPaneHeight,
                                      std::min(ui::metrics::px(260.0F), bodyHeight * 0.45F)));
        const float editorHeight = std::max(
            minimumPaneHeight, bodyHeight - terminalHeight - shellStyle.ItemSpacing.y);
        ImGui::BeginChild("##editor-or-graph", ImVec2(0.0F, editorHeight), ImGuiChildFlags_Borders);
        if (connectionState == ConnectionState::Blocked) {
            if (kit::blockedState("Desktop service blocked", blockedReason.c_str(), "Retry") && connected) {
                bootstrap();
            }
        } else if (activity == Activity::Sessions) {
            if (copilotView.sessionPath().empty()) {
                (void)kit::emptyState(
                    "No active session",
                    "Select a session to inspect its execution hierarchy.");
            } else {
                (void)sessionDagView.draw("##session-dag-view", ImVec2(0.0F, 0.0F));
            }
        } else if (activeWorkspace.empty()) {
            if (kit::emptyState("Open a project", "Choose a recent project or open a folder to begin.",
                                "Open Folder")) {
                workspaceView.requestOpenFolder();
            }
        } else if (activity == Activity::Graph) {
            (void)graphView.draw("##graph-view", ImVec2(0.0F, 0.0F));
        } else {
            editor.draw("##editor", 0.0F, 0.0F);
        }
        ImGui::EndChild();

        ImGui::BeginChild("##terminal-panel", ImVec2(0.0F, 0.0F), ImGuiChildFlags_Borders);
        ImGui::TextUnformatted("TERMINAL");
        ImGui::Separator();
        const auto terminal = terminalByWorkspace.find(activeWorkspace);
        if (terminal == terminalByWorkspace.end()) {
            if (activeWorkspace.empty()) {
                // Block-level hint in a panel that gets narrow; wrap it rather
                // than let it run under the panel border.
                ImGui::PushTextWrapPos(0.0F);
                kit::dimText("Open a project to start a terminal.");
                ImGui::PopTextWrapPos();
            } else if (terminalPending.contains(activeWorkspace)) {
                kit::spinner("Starting terminal");
            } else if (kit::emptyState("Terminal unavailable", "The terminal is not running.", "Start")) {
                ensureTerminal();
            }
        } else {
            (void)terminalView.draw(terminalModels, terminal->second, ImVec2(0.0F, 0.0F));
        }
        ImGui::EndChild();
        ImGui::EndChild();
        ImGui::SameLine(0.0F, 0.0F);

        ImGui::BeginChild("##copilot-panel", ImVec2(0.0F, bodyHeight), ImGuiChildFlags_Borders);
        if (copilotView.sessionPath().empty()) {
            (void)kit::emptyState("No active session",
                                  "Select a session tab to open its transcript and composer.");
        } else {
            copilotView.draw(ImVec2(0.0F, 0.0F));
        }
        ImGui::EndChild();

        ImGui::PushStyleColor(ImGuiCol_ChildBg, ui::palette().statusBg);
        ImGui::BeginChild("##status-bar", ImVec2(0.0F, statusHeight), ImGuiChildFlags_Borders);
        if (connectionState == ConnectionState::Ready) {
            ImGui::TextColored(ui::palette().statusOk, "Connected");
        } else if (connectionState == ConnectionState::Blocked) {
            ImGui::TextColored(ui::palette().statusErr, "Blocked");
        } else {
            ImGui::TextColored(ui::palette().statusPending, connected ? "Negotiating" : "Reconnecting");
        }
        if (const auto* descriptor = workspaceView.currentWorkspace()) {
            ImGui::SameLine();
            ImGui::Text("| %s", descriptor->displayName.c_str());
        }
        if (store.activeSessionPath()) {
            ImGui::SameLine();
            ImGui::Text("| %zu sessions", store.tabs().size());
        }
        const std::size_t issueCount = store.errors().size();
        const std::size_t dropped = transport.droppedIncoming();
        if (issueCount > 0 || dropped > 0 || store.unknownEventCount() > 0) {
            const std::string summary = std::to_string(issueCount) + " errors | " +
                                        std::to_string(store.unknownEventCount()) + " unknown | " +
                                        std::to_string(dropped) + " dropped";
            ImGui::SameLine(std::max(0.0F, ImGui::GetWindowWidth() -
                                              ImGui::CalcTextSize(summary.c_str()).x - 14.0F));
            ImGui::TextColored(issueCount > 0 || dropped > 0 ? ui::palette().statusErr
                                                             : ui::palette().statusWarn,
                               "%s", summary.c_str());
        }
        ImGui::EndChild();
        ImGui::PopStyleColor();
        ImGui::End();

        ImGui::Render();
        int framebufferWidth = 0;
        int framebufferHeight = 0;
        glfwGetFramebufferSize(window.window, &framebufferWidth, &framebufferHeight);
        glViewport(0, 0, framebufferWidth, framebufferHeight);
        const auto background = ui::palette().windowBg;
        glClearColor(background.x, background.y, background.z, background.w);
        glClear(GL_COLOR_BUFFER_BIT);
        ImGui_ImplOpenGL3_RenderDrawData(ImGui::GetDrawData());

        ++renderedFrames;
        const bool settled = connected && connectionState == ConnectionState::Ready &&
                             bootstrapOutstanding == 0 && client.pendingCount() == 0;
        settledFrames = settled ? settledFrames + 1U : 0U;
        const bool bounded = options.frameLimit > 0 && renderedFrames >= options.frameLimit;
        if (options.screenshotPath && !screenshotWritten && (settledFrames >= 6U || bounded)) {
            captureScreenshot(*options.screenshotPath, framebufferWidth, framebufferHeight);
            screenshotWritten = true;
            glfwSetWindowShouldClose(window.window, GLFW_TRUE);
        } else if (!options.screenshotPath && bounded) {
            glfwSetWindowShouldClose(window.window, GLFW_TRUE);
        }

        glfwSwapBuffers(window.window);
        if (!anim::consumeFrameRequest()) std::this_thread::sleep_for(std::chrono::milliseconds(4));
    }

    client.stop();
    return 0;
}

}  // namespace chud::app
