#ifndef OMP_CATALOG_H
#define OMP_CATALOG_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct OmpCatalog OmpCatalog;

typedef struct OmpCatalogSlice {
	const uint8_t *data;
	size_t length;
} OmpCatalogSlice;

int omp_catalog_open_file(const char *utf8_path, OmpCatalog **out, char *error, size_t error_capacity);
int omp_catalog_open_memory(
	const uint8_t *bytes,
	size_t length,
	OmpCatalog **out,
	char *error,
	size_t error_capacity
);
void omp_catalog_close(OmpCatalog *catalog);
size_t omp_catalog_provider_count(const OmpCatalog *catalog);
int omp_catalog_provider_at(const OmpCatalog *catalog, size_t index, OmpCatalogSlice *name, uint32_t *ordinal);
int omp_catalog_provider_payload(
	const OmpCatalog *catalog,
	const uint8_t *name,
	size_t name_length,
	OmpCatalogSlice *payload
);
size_t omp_catalog_mapped_bytes(const OmpCatalog *catalog);
int omp_catalog_is_file_backed(const OmpCatalog *catalog);

#ifdef __cplusplus
}
#endif

#endif
