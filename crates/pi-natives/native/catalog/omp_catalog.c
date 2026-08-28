#include "omp_catalog.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if defined(_WIN32)
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#else
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>
#endif

#define OMP_CATALOG_HEADER_BYTES 24u
#define OMP_CATALOG_INDEX_FIXED_BYTES 24u
#define OMP_CATALOG_ALIGNMENT 8u
#define OMP_CATALOG_SCHEMA_VERSION 1u

static const uint8_t OMP_CATALOG_MAGIC[8] = {'O', 'M', 'P', 'C', 'A', 'T', '1', 0};

typedef struct CatalogLayout {
	size_t provider_count;
	size_t payload_offset;
} CatalogLayout;

struct OmpCatalog {
	const uint8_t *bytes;
	size_t length;
	size_t provider_count;
	size_t payload_offset;
	int file_backed;
#if defined(_WIN32)
	HANDLE file_handle;
	HANDLE mapping_handle;
#else
	int file_descriptor;
#endif
};

static void set_error(char *error, size_t capacity, const char *format, ...) {
	va_list arguments;
	if (error == NULL || capacity == 0) {
		return;
	}
	va_start(arguments, format);
	(void)vsnprintf(error, capacity, format, arguments);
	va_end(arguments);
	error[capacity - 1] = '\0';
}

static uint16_t read_u16_le(const uint8_t *bytes) {
	return (uint16_t)bytes[0] | ((uint16_t)bytes[1] << 8u);
}

static uint32_t read_u32_le(const uint8_t *bytes) {
	return (uint32_t)bytes[0] | ((uint32_t)bytes[1] << 8u) | ((uint32_t)bytes[2] << 16u) |
		((uint32_t)bytes[3] << 24u);
}

static uint64_t read_u64_le(const uint8_t *bytes) {
	return (uint64_t)read_u32_le(bytes) | ((uint64_t)read_u32_le(bytes + 4) << 32u);
}

static int checked_add(size_t left, size_t right, size_t *result) {
	if (left > SIZE_MAX - right) {
		return -1;
	}
	*result = left + right;
	return 0;
}

static int align8(size_t value, size_t *result) {
	size_t with_padding;
	if (checked_add(value, OMP_CATALOG_ALIGNMENT - 1u, &with_padding) != 0) {
		return -1;
	}
	*result = with_padding & ~(size_t)(OMP_CATALOG_ALIGNMENT - 1u);
	return 0;
}

static int u64_to_size(uint64_t value, size_t *result) {
	if (value > (uint64_t)SIZE_MAX) {
		return -1;
	}
	*result = (size_t)value;
	return 0;
}

static int bytes_are_zero(const uint8_t *bytes, size_t begin, size_t end) {
	size_t index;
	for (index = begin; index < end; index += 1u) {
		if (bytes[index] != 0) {
			return 0;
		}
	}
	return 1;
}

static int valid_utf8(const uint8_t *bytes, size_t length) {
	size_t index = 0;
	while (index < length) {
		uint8_t first = bytes[index];
		if (first <= 0x7fu) {
			index += 1u;
			continue;
		}
		if (first >= 0xc2u && first <= 0xdfu) {
			if (index + 1u >= length || (bytes[index + 1u] & 0xc0u) != 0x80u) return 0;
			index += 2u;
			continue;
		}
		if (first == 0xe0u) {
			if (index + 2u >= length || bytes[index + 1u] < 0xa0u || bytes[index + 1u] > 0xbfu ||
				(bytes[index + 2u] & 0xc0u) != 0x80u)
				return 0;
			index += 3u;
			continue;
		}
		if ((first >= 0xe1u && first <= 0xecu) || (first >= 0xeeu && first <= 0xefu)) {
			if (index + 2u >= length || (bytes[index + 1u] & 0xc0u) != 0x80u ||
				(bytes[index + 2u] & 0xc0u) != 0x80u)
				return 0;
			index += 3u;
			continue;
		}
		if (first == 0xedu) {
			if (index + 2u >= length || bytes[index + 1u] < 0x80u || bytes[index + 1u] > 0x9fu ||
				(bytes[index + 2u] & 0xc0u) != 0x80u)
				return 0;
			index += 3u;
			continue;
		}
		if (first == 0xf0u) {
			if (index + 3u >= length || bytes[index + 1u] < 0x90u || bytes[index + 1u] > 0xbfu ||
				(bytes[index + 2u] & 0xc0u) != 0x80u || (bytes[index + 3u] & 0xc0u) != 0x80u)
				return 0;
			index += 4u;
			continue;
		}
		if (first >= 0xf1u && first <= 0xf3u) {
			if (index + 3u >= length || (bytes[index + 1u] & 0xc0u) != 0x80u ||
				(bytes[index + 2u] & 0xc0u) != 0x80u || (bytes[index + 3u] & 0xc0u) != 0x80u)
				return 0;
			index += 4u;
			continue;
		}
		if (first == 0xf4u) {
			if (index + 3u >= length || bytes[index + 1u] < 0x80u || bytes[index + 1u] > 0x8fu ||
				(bytes[index + 2u] & 0xc0u) != 0x80u || (bytes[index + 3u] & 0xc0u) != 0x80u)
				return 0;
			index += 4u;
			continue;
		}
		return 0;
	}
	return 1;
}

static int validate_catalog(
	const uint8_t *bytes,
	size_t length,
	CatalogLayout *layout,
	char *error,
	size_t error_capacity
) {
	uint32_t provider_count;
	size_t payload_offset;
	size_t index_offset = OMP_CATALOG_HEADER_BYTES;
	size_t previous_payload_end;
	size_t provider_index;

	if (length < OMP_CATALOG_HEADER_BYTES) {
		set_error(error, error_capacity, "catalog is truncated: expected at least %u bytes, got %zu", OMP_CATALOG_HEADER_BYTES, length);
		return -1;
	}
	if (memcmp(bytes, OMP_CATALOG_MAGIC, sizeof(OMP_CATALOG_MAGIC)) != 0) {
		set_error(error, error_capacity, "catalog magic mismatch: expected OMPCAT1");
		return -1;
	}
	if (read_u32_le(bytes + 8) != OMP_CATALOG_SCHEMA_VERSION) {
		set_error(
			error,
			error_capacity,
			"unsupported catalog schema version %u (expected %u)",
			read_u32_le(bytes + 8),
			OMP_CATALOG_SCHEMA_VERSION
		);
		return -1;
	}
	provider_count = read_u32_le(bytes + 12);
	if (u64_to_size(read_u64_le(bytes + 16), &payload_offset) != 0 || payload_offset > length) {
		set_error(error, error_capacity, "catalog payload-section offset is outside the %zu-byte file", length);
		return -1;
	}
	if ((payload_offset & (OMP_CATALOG_ALIGNMENT - 1u)) != 0) {
		set_error(error, error_capacity, "catalog payload-section offset %zu is not 8-byte aligned", payload_offset);
		return -1;
	}

	previous_payload_end = payload_offset;
	for (provider_index = 0; provider_index < (size_t)provider_count; provider_index += 1u) {
		const uint8_t *record;
		uint16_t name_length;
		uint16_t reserved;
		uint32_t ordinal;
		size_t name_end;
		size_t next_index_offset;
		size_t provider_payload_offset;
		size_t provider_payload_length;
		size_t expected_payload_offset;
		size_t provider_payload_end;

		if (index_offset > payload_offset || payload_offset - index_offset < OMP_CATALOG_INDEX_FIXED_BYTES) {
			set_error(error, error_capacity, "catalog index is truncated at provider %zu", provider_index);
			return -1;
		}
		record = bytes + index_offset;
		name_length = read_u16_le(record);
		reserved = read_u16_le(record + 2);
		ordinal = read_u32_le(record + 4);
		if (reserved != 0) {
			set_error(error, error_capacity, "catalog provider %zu has nonzero reserved index bits", provider_index);
			return -1;
		}
		if (ordinal != (uint32_t)provider_index) {
			set_error(error, error_capacity, "catalog provider %zu has ordinal %u", provider_index, ordinal);
			return -1;
		}
		if (checked_add(index_offset, OMP_CATALOG_INDEX_FIXED_BYTES, &name_end) != 0 ||
			checked_add(name_end, (size_t)name_length, &name_end) != 0 || name_end > payload_offset) {
			set_error(error, error_capacity, "catalog provider %zu name extends beyond the index", provider_index);
			return -1;
		}
		if (!valid_utf8(record + OMP_CATALOG_INDEX_FIXED_BYTES, (size_t)name_length)) {
			set_error(error, error_capacity, "catalog provider %zu name is not valid UTF-8", provider_index);
			return -1;
		}
		if (align8(name_end, &next_index_offset) != 0 || next_index_offset > payload_offset) {
			set_error(error, error_capacity, "catalog provider %zu index alignment is out of bounds", provider_index);
			return -1;
		}
		if (!bytes_are_zero(bytes, name_end, next_index_offset)) {
			set_error(error, error_capacity, "catalog provider %zu index padding is nonzero", provider_index);
			return -1;
		}
		if (u64_to_size(read_u64_le(record + 8), &provider_payload_offset) != 0 ||
			u64_to_size(read_u64_le(record + 16), &provider_payload_length) != 0) {
			set_error(error, error_capacity, "catalog provider %zu payload offset or length exceeds this platform", provider_index);
			return -1;
		}
		if (align8(previous_payload_end, &expected_payload_offset) != 0 ||
			provider_payload_offset != expected_payload_offset) {
			set_error(
				error,
				error_capacity,
				"catalog provider %zu payload offset %zu does not follow the previous payload at %zu",
				provider_index,
				provider_payload_offset,
				previous_payload_end
			);
			return -1;
		}
		if ((provider_payload_offset & (OMP_CATALOG_ALIGNMENT - 1u)) != 0) {
			set_error(error, error_capacity, "catalog provider %zu payload is not 8-byte aligned", provider_index);
			return -1;
		}
		if (!bytes_are_zero(bytes, previous_payload_end, provider_payload_offset)) {
			set_error(error, error_capacity, "catalog provider %zu payload padding is nonzero", provider_index);
			return -1;
		}
		if (checked_add(provider_payload_offset, provider_payload_length, &provider_payload_end) != 0 ||
			provider_payload_end > length) {
			set_error(error, error_capacity, "catalog provider %zu payload is outside the %zu-byte file", provider_index, length);
			return -1;
		}
		previous_payload_end = provider_payload_end;
		index_offset = next_index_offset;
	}

	if (index_offset != payload_offset) {
		set_error(
			error,
			error_capacity,
			"catalog payload-section offset %zu does not equal aligned index end %zu",
			payload_offset,
			index_offset
		);
		return -1;
	}
	if (previous_payload_end != length) {
		set_error(error, error_capacity, "catalog final payload ends at %zu, not EOF %zu", previous_payload_end, length);
		return -1;
	}
	layout->provider_count = (size_t)provider_count;
	layout->payload_offset = payload_offset;
	return 0;
}

static OmpCatalog *allocate_catalog(const uint8_t *bytes, size_t length, const CatalogLayout *layout) {
	OmpCatalog *catalog = (OmpCatalog *)calloc(1u, sizeof(OmpCatalog));
	if (catalog == NULL) {
		return NULL;
	}
	catalog->bytes = bytes;
	catalog->length = length;
	catalog->provider_count = layout->provider_count;
	catalog->payload_offset = layout->payload_offset;
#if !defined(_WIN32)
	catalog->file_descriptor = -1;
#endif
	return catalog;
}

int omp_catalog_open_memory(
	const uint8_t *bytes,
	size_t length,
	OmpCatalog **out,
	char *error,
	size_t error_capacity
) {
	uint8_t *owned_bytes;
	CatalogLayout layout;
	OmpCatalog *catalog;

	if (out == NULL) {
		set_error(error, error_capacity, "catalog output handle pointer is null");
		return -1;
	}
	*out = NULL;
	if (bytes == NULL) {
		set_error(error, error_capacity, "catalog memory input is null");
		return -1;
	}
	if (length == 0) {
		set_error(error, error_capacity, "catalog memory input is empty");
		return -1;
	}
	owned_bytes = (uint8_t *)malloc(length);
	if (owned_bytes == NULL) {
		set_error(error, error_capacity, "could not allocate %zu bytes for catalog copy", length);
		return -1;
	}
	memcpy(owned_bytes, bytes, length);
	if (validate_catalog(owned_bytes, length, &layout, error, error_capacity) != 0) {
		free(owned_bytes);
		return -1;
	}
	catalog = allocate_catalog(owned_bytes, length, &layout);
	if (catalog == NULL) {
		free(owned_bytes);
		set_error(error, error_capacity, "could not allocate catalog handle");
		return -1;
	}
	catalog->file_backed = 0;
	*out = catalog;
	return 0;
}

#if defined(_WIN32)
int omp_catalog_open_file(const char *utf8_path, OmpCatalog **out, char *error, size_t error_capacity) {
	int wide_length;
	wchar_t *wide_path;
	HANDLE file_handle;
	HANDLE mapping_handle;
	LARGE_INTEGER file_size;
	const uint8_t *mapping;
	size_t length;
	CatalogLayout layout;
	OmpCatalog *catalog;

	if (out == NULL) {
		set_error(error, error_capacity, "catalog output handle pointer is null");
		return -1;
	}
	*out = NULL;
	if (utf8_path == NULL || utf8_path[0] == '\0') {
		set_error(error, error_capacity, "catalog file path is empty");
		return -1;
	}
	wide_length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, utf8_path, -1, NULL, 0);
	if (wide_length == 0) {
		set_error(error, error_capacity, "catalog path is not valid UTF-8 (Windows error %lu)", (unsigned long)GetLastError());
		return -1;
	}
	wide_path = (wchar_t *)malloc((size_t)wide_length * sizeof(wchar_t));
	if (wide_path == NULL) {
		set_error(error, error_capacity, "could not allocate converted catalog path");
		return -1;
	}
	if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, utf8_path, -1, wide_path, wide_length) == 0) {
		set_error(error, error_capacity, "could not convert catalog path (Windows error %lu)", (unsigned long)GetLastError());
		free(wide_path);
		return -1;
	}
	file_handle = CreateFileW(
		wide_path,
		GENERIC_READ,
		FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
		NULL,
		OPEN_EXISTING,
		FILE_ATTRIBUTE_NORMAL,
		NULL
	);
	free(wide_path);
	if (file_handle == INVALID_HANDLE_VALUE) {
		set_error(error, error_capacity, "could not open catalog file (Windows error %lu)", (unsigned long)GetLastError());
		return -1;
	}
	if (!GetFileSizeEx(file_handle, &file_size) || file_size.QuadPart <= 0 ||
		(uint64_t)file_size.QuadPart > (uint64_t)SIZE_MAX) {
		set_error(error, error_capacity, "catalog file size is invalid (Windows error %lu)", (unsigned long)GetLastError());
		CloseHandle(file_handle);
		return -1;
	}
	length = (size_t)file_size.QuadPart;
	mapping_handle = CreateFileMappingW(file_handle, NULL, PAGE_READONLY, 0, 0, NULL);
	if (mapping_handle == NULL) {
		set_error(error, error_capacity, "could not create catalog file mapping (Windows error %lu)", (unsigned long)GetLastError());
		CloseHandle(file_handle);
		return -1;
	}
	mapping = (const uint8_t *)MapViewOfFile(mapping_handle, FILE_MAP_READ, 0, 0, 0);
	if (mapping == NULL) {
		set_error(error, error_capacity, "could not map catalog file (Windows error %lu)", (unsigned long)GetLastError());
		CloseHandle(mapping_handle);
		CloseHandle(file_handle);
		return -1;
	}
	if (validate_catalog(mapping, length, &layout, error, error_capacity) != 0) {
		UnmapViewOfFile(mapping);
		CloseHandle(mapping_handle);
		CloseHandle(file_handle);
		return -1;
	}
	catalog = allocate_catalog(mapping, length, &layout);
	if (catalog == NULL) {
		set_error(error, error_capacity, "could not allocate catalog handle");
		UnmapViewOfFile(mapping);
		CloseHandle(mapping_handle);
		CloseHandle(file_handle);
		return -1;
	}
	catalog->file_backed = 1;
	catalog->file_handle = file_handle;
	catalog->mapping_handle = mapping_handle;
	*out = catalog;
	return 0;
}
#else
int omp_catalog_open_file(const char *utf8_path, OmpCatalog **out, char *error, size_t error_capacity) {
	int file_descriptor;
	struct stat status;
	size_t length;
	const uint8_t *mapping;
	CatalogLayout layout;
	OmpCatalog *catalog;

	if (out == NULL) {
		set_error(error, error_capacity, "catalog output handle pointer is null");
		return -1;
	}
	*out = NULL;
	if (utf8_path == NULL || utf8_path[0] == '\0') {
		set_error(error, error_capacity, "catalog file path is empty");
		return -1;
	}
	file_descriptor = open(utf8_path, O_RDONLY);
	if (file_descriptor < 0) {
		set_error(error, error_capacity, "could not open catalog file '%s': %s", utf8_path, strerror(errno));
		return -1;
	}
	if (fstat(file_descriptor, &status) != 0) {
		set_error(error, error_capacity, "could not stat catalog file '%s': %s", utf8_path, strerror(errno));
		close(file_descriptor);
		return -1;
	}
	if (status.st_size <= 0 || (uintmax_t)status.st_size > (uintmax_t)SIZE_MAX) {
		set_error(error, error_capacity, "catalog file '%s' has invalid size", utf8_path);
		close(file_descriptor);
		return -1;
	}
	length = (size_t)status.st_size;
	mapping = (const uint8_t *)mmap(NULL, length, PROT_READ, MAP_PRIVATE, file_descriptor, 0);
	if (mapping == MAP_FAILED) {
		set_error(error, error_capacity, "could not map catalog file '%s': %s", utf8_path, strerror(errno));
		close(file_descriptor);
		return -1;
	}
	if (validate_catalog(mapping, length, &layout, error, error_capacity) != 0) {
		munmap((void *)mapping, length);
		close(file_descriptor);
		return -1;
	}
	catalog = allocate_catalog(mapping, length, &layout);
	if (catalog == NULL) {
		set_error(error, error_capacity, "could not allocate catalog handle");
		munmap((void *)mapping, length);
		close(file_descriptor);
		return -1;
	}
	catalog->file_backed = 1;
	catalog->file_descriptor = file_descriptor;
	*out = catalog;
	return 0;
}
#endif

void omp_catalog_close(OmpCatalog *catalog) {
	if (catalog == NULL) {
		return;
	}
	if (catalog->file_backed) {
#if defined(_WIN32)
		UnmapViewOfFile(catalog->bytes);
		CloseHandle(catalog->mapping_handle);
		CloseHandle(catalog->file_handle);
#else
		munmap((void *)catalog->bytes, catalog->length);
		close(catalog->file_descriptor);
#endif
	} else {
		free((void *)catalog->bytes);
	}
	free(catalog);
}

size_t omp_catalog_provider_count(const OmpCatalog *catalog) {
	return catalog == NULL ? 0u : catalog->provider_count;
}

int omp_catalog_provider_at(const OmpCatalog *catalog, size_t index, OmpCatalogSlice *name, uint32_t *ordinal) {
	size_t provider_index;
	size_t index_offset = OMP_CATALOG_HEADER_BYTES;
	if (catalog == NULL || name == NULL || ordinal == NULL || index >= catalog->provider_count) {
		return -1;
	}
	for (provider_index = 0; provider_index <= index; provider_index += 1u) {
		const uint8_t *record = catalog->bytes + index_offset;
		uint16_t name_length = read_u16_le(record);
		if (provider_index == index) {
			name->data = record + OMP_CATALOG_INDEX_FIXED_BYTES;
			name->length = (size_t)name_length;
			*ordinal = read_u32_le(record + 4);
			return 0;
		}
		(void)align8(index_offset + OMP_CATALOG_INDEX_FIXED_BYTES + (size_t)name_length, &index_offset);
	}
	return -1;
}

int omp_catalog_provider_payload(
	const OmpCatalog *catalog,
	const uint8_t *name,
	size_t name_length,
	OmpCatalogSlice *payload
) {
	size_t provider_index;
	size_t index_offset = OMP_CATALOG_HEADER_BYTES;
	if (catalog == NULL || payload == NULL || (name == NULL && name_length != 0)) {
		return -1;
	}
	payload->data = NULL;
	payload->length = 0;
	for (provider_index = 0; provider_index < catalog->provider_count; provider_index += 1u) {
		const uint8_t *record = catalog->bytes + index_offset;
		uint16_t provider_name_length = read_u16_le(record);
		if ((size_t)provider_name_length == name_length &&
			(name_length == 0 || memcmp(record + OMP_CATALOG_INDEX_FIXED_BYTES, name, name_length) == 0)) {
			size_t payload_offset = (size_t)read_u64_le(record + 8);
			payload->data = catalog->bytes + payload_offset;
			payload->length = (size_t)read_u64_le(record + 16);
			return 1;
		}
		(void)align8(index_offset + OMP_CATALOG_INDEX_FIXED_BYTES + (size_t)provider_name_length, &index_offset);
	}
	return 0;
}

size_t omp_catalog_mapped_bytes(const OmpCatalog *catalog) {
	return catalog == NULL ? 0u : catalog->length;
}

int omp_catalog_is_file_backed(const OmpCatalog *catalog) {
	return catalog == NULL ? 0 : catalog->file_backed;
}
