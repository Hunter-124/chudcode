#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

namespace fs = std::filesystem;

class TemporaryDirectory {
public:
    TemporaryDirectory() {
        const auto suffix = std::to_string(
            std::chrono::steady_clock::now().time_since_epoch().count());
        path_ = fs::temp_directory_path() / ("chudcode-app-ini-" + suffix);
        fs::create_directories(path_);
    }

    ~TemporaryDirectory() {
        std::error_code error;
        fs::remove_all(path_, error);
    }

    [[nodiscard]] const fs::path& path() const noexcept { return path_; }

private:
    fs::path path_;
};

class CurrentPathGuard {
public:
    CurrentPathGuard() : original_(fs::current_path()) {}

    ~CurrentPathGuard() {
        std::error_code error;
        fs::current_path(original_, error);
    }

private:
    fs::path original_;
};

void setEnvironment(const char* name, const std::string& value) {
#ifdef _WIN32
    if (_putenv_s(name, value.c_str()) != 0) {
        throw std::runtime_error(std::string("failed to set ") + name);
    }
#else
    if (setenv(name, value.c_str(), 1) != 0) {
        throw std::runtime_error(std::string("failed to set ") + name);
    }
#endif
}

std::string quote(const fs::path& path) {
    std::string result = "\"";
    for (const char character : path.string()) {
        if (character == '\"') result += '\\';
        result += character;
    }
    result += '\"';
    return result;
}

void require(bool condition, const std::string& message) {
    if (!condition) throw std::runtime_error(message);
}

}  // namespace

int main(int argc, char** argv) {
    try {
        require(argc == 2, "expected the chudcode-gui executable path");
        const fs::path executable = fs::absolute(argv[1]);
        require(fs::is_regular_file(executable), "chudcode-gui executable is missing");

        TemporaryDirectory temporary;
        CurrentPathGuard currentPathGuard;
        const fs::path cwd = temporary.path() / "cwd";
        const fs::path dataRoot = temporary.path() / "data";
        fs::create_directories(cwd);
        fs::create_directories(dataRoot);
        setEnvironment("XDG_DATA_HOME", dataRoot.string());
        setEnvironment("HOME", (temporary.path() / "home").string());
        // GL drivers keep their own shader caches under HOME (Mesa under Xvfb in
        // CI, NVIDIA on desktops). Those are driver state, not app output; turn
        // them off so the scan below still catches any file the app writes.
        setEnvironment("MESA_SHADER_CACHE_DISABLE", "true");
        setEnvironment("__GL_SHADER_DISK_CACHE", "0");
        fs::current_path(cwd);

        const std::string command =
            quote(executable) +
            " --url ws://127.0.0.1:9 --token ini-lifetime-test --frames 1"
            " --width 800 --height 560";
        require(std::system(command.c_str()) == 0, "chudcode-gui did not shut down cleanly");

        const fs::path expected = dataRoot / "Chudcode" / "chudcode-gui" /
                                  CHUDCODE_GUI_VERSION / "imgui.ini";
        require(fs::is_regular_file(expected), "stable imgui.ini was not written");
        require(fs::file_size(expected) > 0, "stable imgui.ini is empty");
        require(fs::is_empty(cwd), "shutdown wrote an unexpected file in the working directory");

        std::vector<fs::path> files;
        for (const auto& entry : fs::recursive_directory_iterator(temporary.path())) {
            if (entry.is_regular_file()) files.push_back(entry.path());
        }
        require(files.size() == 1 && files.front() == expected,
                "shutdown wrote a file outside the stable data-directory ini path");
        std::cout << "app ini lifetime test passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "app ini lifetime test failed: " << error.what() << '\n';
        return 1;
    }
}
