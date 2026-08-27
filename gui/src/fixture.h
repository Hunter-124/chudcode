#pragma once

#include <string>
#include <vector>

namespace omp::gui {

enum class Speaker { User, Assistant };
enum class PartKind { Prose, Code, Diff };

struct MessagePart {
    PartKind kind;
    std::string label;
    std::string text;
};

struct Message {
    Speaker speaker;
    std::string author;
    std::string timestamp;
    std::vector<MessagePart> parts;
};

std::vector<Message>& conversationFixture();

}  // namespace omp::gui
