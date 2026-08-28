#pragma once

#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

#include "protocol/wire_types.h"

namespace chud::json_codec {

class CodecError : public std::runtime_error {
public:
    using std::runtime_error::runtime_error;
};

DesktopFrame parseFrame(std::string_view text);
Json encodeFrameJson(const DesktopFrame& frame);
std::string encodeFrame(const DesktopFrame& frame);

EventFrame parseEvent(const Json& value);
Json encodeEvent(const EventFrame& event);

DocumentSnapshot parseDocumentSnapshot(const Json& value);
Json encodeDocumentSnapshot(const DocumentSnapshot& value);
GitSnapshot parseGitSnapshot(const Json& value);
Json encodeGitSnapshot(const GitSnapshot& value);
GraphSnapshot parseGraphSnapshot(const Json& value);
Json encodeGraphSnapshot(const GraphSnapshot& value);
SessionState parseSessionState(const Json& value);
Json encodeSessionState(const SessionState& value);

bool isSupportedMethod(std::string_view method) noexcept;
const std::vector<std::string_view>& supportedMethods() noexcept;

} // namespace chud::json_codec
