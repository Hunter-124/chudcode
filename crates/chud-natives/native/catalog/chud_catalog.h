#ifndef CHUDCODE_CATALOG_H
#define CHUDCODE_CATALOG_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct ChudCatalog ChudCatalog;

typedef struct ChudCatalogSlice {
	const uint8_t *data;
	size_t length;
} ChudCatalogSlice;

int chudcode_catalog_open_file(const char *utf8_path, ChudCatalog **out, char *error, size_t error_capacity);
int chudcode_catalog_open_memory(
	const uint8_t *bytes,
	size_t length,
	ChudCatalog **out,
	char *error,
	size_t error_capacity
);
void chudcode_catalog_close(ChudCatalog *catalog);
size_t chudcode_catalog_provider_count(const ChudCatalog *catalog);
int chudcode_catalog_provider_at(const ChudCatalog *catalog, size_t index, ChudCatalogSlice *name, uint32_t *ordinal);
int chudcode_catalog_provider_payload(
	const ChudCatalog *catalog,
	const uint8_t *name,
	size_t name_length,
	ChudCatalogSlice *payload
);
size_t chudcode_catalog_mapped_bytes(const ChudCatalog *catalog);
int chudcode_catalog_is_file_backed(const ChudCatalog *catalog);

#ifdef __cplusplus
}
#endif

#endif
