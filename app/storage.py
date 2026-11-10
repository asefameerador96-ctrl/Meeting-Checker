"""Image blob storage: local filesystem (dev) or Azure Blob Storage (prod)."""
from datetime import datetime, timedelta, timezone

from fastapi.responses import FileResponse, RedirectResponse, Response

from .config import settings


class LocalStorage:
    def __init__(self, root):
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)

    def put(self, key: str, data: bytes, content_type: str):
        p = self.root / key
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)

    def delete(self, key: str):
        p = self.root / key
        if p.exists():
            p.unlink()

    def response(self, key: str, content_type: str) -> Response:
        p = self.root / key
        if not p.exists():
            return Response(status_code=404)
        return FileResponse(p, media_type=content_type, headers={"Cache-Control": "private, max-age=86400"})


class AzureBlobStorage:
    def __init__(self, conn_str: str, container: str):
        from azure.storage.blob import BlobServiceClient
        self.svc = BlobServiceClient.from_connection_string(conn_str)
        self.container = self.svc.get_container_client(container)
        try:
            self.container.create_container()
        except Exception:
            pass  # exists
        self.account_name = self.svc.account_name
        self.account_key = self.svc.credential.account_key if hasattr(self.svc.credential, "account_key") else None

    def put(self, key: str, data: bytes, content_type: str):
        from azure.storage.blob import ContentSettings
        self.container.upload_blob(key, data, overwrite=True,
                                   content_settings=ContentSettings(content_type=content_type,
                                                                    cache_control="private, max-age=86400"))

    def delete(self, key: str):
        try:
            self.container.delete_blob(key)
        except Exception:
            pass

    def response(self, key: str, content_type: str) -> Response:
        if self.account_key:
            from azure.storage.blob import BlobSasPermissions, generate_blob_sas
            sas = generate_blob_sas(self.account_name, self.container.container_name, key,
                                    account_key=self.account_key, permission=BlobSasPermissions(read=True),
                                    expiry=datetime.now(timezone.utc) + timedelta(minutes=30))
            return RedirectResponse(f"{self.container.url}/{key}?{sas}", status_code=302)
        data = self.container.download_blob(key).readall()
        return Response(data, media_type=content_type)


_storage = None


def get_storage():
    global _storage
    if _storage is None:
        if settings.STORAGE_BACKEND == "azure":
            _storage = AzureBlobStorage(settings.AZURE_STORAGE_CONNECTION_STRING, settings.AZURE_STORAGE_CONTAINER)
        else:
            _storage = LocalStorage(settings.LOCAL_UPLOAD_DIR)
    return _storage
