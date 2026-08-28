#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <variant>
#include <vector>

namespace chud {
class DesktopClient;
}

namespace chud::editor {

struct FileStamp {
    std::string sha256;
    std::uint64_t size = 0;
    std::uint64_t mtimeNs = 0;
    std::uint64_t generation = 0;
};

struct Snapshot {
    std::string id;
    std::string uri;
    std::string language;
    std::string text;
    FileStamp stamp;
};

struct Position {
    std::size_t line = 0;
    // LSP columns are UTF-16 code-unit offsets. Editor columns are UTF-8 glyph indices.
    std::size_t column = 0;
    friend bool operator==(const Position&, const Position&) = default;
};

struct Range {
    Position start;
    Position end;
    friend bool operator==(const Range&, const Range&) = default;
};

enum class DiagnosticSeverity : std::uint8_t { Error = 1, Warning = 2, Information = 3, Hint = 4 };

struct Diagnostic {
    std::string uri;
    DiagnosticSeverity severity = DiagnosticSeverity::Information;
    std::string message;
    std::string source;
    Range range;
};

struct Location { std::string uri; Range range; };
struct Hover { std::string markdown; std::optional<Range> range; };
struct CompletionItem { std::string label; std::string insertText; std::string detail; };
struct CodeAction { std::string title; std::string kind; std::string opaqueId; };

enum class LspFeature : std::uint8_t { Definition, References, Hover, Completion, CodeAction };

struct LspRequest {
    LspFeature feature = LspFeature::Definition;
    std::string workspaceId;
    std::string uri;
    Position position;
    std::optional<Range> range;
    std::vector<Diagnostic> diagnostics;
    std::string query;
    bool includeDeclaration = true;
};

using LspValue = std::variant<std::monostate, std::vector<Location>, Hover,
                              std::vector<CompletionItem>, std::vector<CodeAction>>;

struct RequestError {
    std::string code;
    std::string message;
    [[nodiscard]] bool isConflict() const noexcept;
};

template <typename T>
using Result = std::variant<T, RequestError>;

struct EditorRequests {
    using ReadCallback = std::function<void(Result<Snapshot>)>;
    using WriteCallback = std::function<void(Result<FileStamp>)>;
    using LspCallback = std::function<void(Result<LspValue>)>;

    std::function<void(std::string workspaceId, std::string uri, ReadCallback)> read;
    std::function<void(std::string workspaceId, std::string uri, std::string text,
                       std::string expectedSha256, WriteCallback)> write;
    std::function<void(LspRequest, LspCallback)> lsp;

    // Adapter for the repository's asynchronous DesktopClient. Callbacks are still
    // marshalled by EditorPanel, so a transport callback never touches ImGui state.
    static EditorRequests forProtocolClient(DesktopClient& client);
};

enum class DocumentStatus : std::uint8_t { Loading, Ready, Saving, Conflict, Error };
enum class FallbackMode : std::uint8_t { None, Binary, Oversized, LongLine };
enum class ChangeOrigin : std::uint8_t { External, Agent, User };

struct CursorState {
    std::size_t line = 0;
    std::size_t glyph = 0;
    std::size_t anchorLine = 0;
    std::size_t anchorGlyph = 0;
    friend bool operator==(const CursorState&, const CursorState&) = default;
};

struct ViewState {
    CursorState cursor;
    std::size_t firstVisibleLine = 0;
    bool wordWrap = false;
    bool miniMap = false;
    friend bool operator==(const ViewState&, const ViewState&) = default;
};

struct LineRegion {
    std::size_t first = 0;
    std::size_t last = 0;
    friend bool operator==(const LineRegion&, const LineRegion&) = default;
};

struct LineFlash {
    LineRegion region;
    float remainingSeconds = 0.0F;
    bool active = false;
};

struct DocumentState {
    std::string id;
    std::string uri;
    std::string language;
    std::string text;
    std::string baseText;
    FileStamp stamp;
    DocumentStatus status = DocumentStatus::Loading;
    FallbackMode fallback = FallbackMode::None;
    bool dirty = false;
    bool conflict = false;
    std::string error;
    ViewState view;
    std::vector<Diagnostic> diagnostics;
    LineFlash flash;
    std::uint64_t editRevision = 0;
};

class EditorPanel {
public:
    static constexpr std::size_t kMaximumEditableBytes = 10U * 1024U * 1024U;
    static constexpr std::size_t kMaximumEditableLineBytes = 64U * 1024U;
    static constexpr std::size_t kFallbackPreviewBytes = 64U * 1024U;

    explicit EditorPanel(EditorRequests requests = {});
    ~EditorPanel();
    EditorPanel(EditorPanel&&) noexcept;
    EditorPanel& operator=(EditorPanel&&) noexcept;
    EditorPanel(const EditorPanel&) = delete;
    EditorPanel& operator=(const EditorPanel&) = delete;

    void setWorkspace(std::string workspaceId);
    [[nodiscard]] const std::string& workspace() const noexcept;
    void open(std::string uri);
    [[nodiscard]] bool close(std::string_view uri, bool discardDirty = false);
    [[nodiscard]] bool activate(std::string_view uri);
    [[nodiscard]] std::string_view activeUri() const noexcept;
    [[nodiscard]] const std::vector<std::string>& tabs() const noexcept;
    [[nodiscard]] const DocumentState* document(std::string_view uri) const noexcept;
    [[nodiscard]] DocumentState* document(std::string_view uri) noexcept;

    // Pure state entry points are public for headless tests and non-rendering hosts.
    void acceptSnapshot(Snapshot snapshot, bool preserveView = true,
                        ChangeOrigin origin = ChangeOrigin::External);
    void replaceText(std::string_view uri, std::string text);
    void setView(std::string_view uri, ViewState view);
    void save(std::string_view uri = {});
    void reloadDiscardingLocal(std::string_view uri = {});
    void keepLocalAgainstLatest(std::string_view uri = {});
    void fileChanged(std::string uri, ChangeOrigin origin, std::optional<FileStamp> stamp = std::nullopt);

    void setDiagnostics(std::string uri, std::vector<Diagnostic> diagnostics);
    void requestDefinition();
    void requestReferences();
    void requestHover();
    void requestCompletion(std::string query = {});
    void requestCodeActions(std::optional<Range> range = std::nullopt);
    void setLspResultHandler(std::function<void(LspFeature, Result<LspValue>)> handler);

    // Drain callbacks on the owning thread before rendering. Safe when protocol
    // callbacks were delivered from worker threads.
    void processCallbacks();
    void advanceAnimations(float deltaSeconds);

    // TextEditor owns platform-native mouse selection, multi-cursor semantics,
    // and Windows-style key chords; these commands expose the same undo stack.
    void cut();
    void copy();
    void paste();
    void selectAll();
    void addNextOccurrence(bool wholeWord = false);
    void selectAllOccurrences(bool wholeWord = false);
    void undo();
    void redo();
    [[nodiscard]] bool canUndo() const;
    [[nodiscard]] bool canRedo() const;

    // Requires a current Dear ImGui context and must run on the constructing thread.
    void draw(const char* id, float width = 0.0F, float height = 0.0F);

    [[nodiscard]] static FallbackMode fallbackFor(std::string_view text) noexcept;
    [[nodiscard]] static LineRegion changedLines(std::string_view before, std::string_view after) noexcept;
    [[nodiscard]] static std::size_t utf16ColumnToGlyph(std::string_view utf8Line,
                                                        std::size_t utf16Column) noexcept;
    [[nodiscard]] static std::size_t glyphToUtf16Column(std::string_view utf8Line,
                                                        std::size_t glyphColumn) noexcept;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace chud::editor
