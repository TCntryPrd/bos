from dataclasses import dataclass, field
from datetime import datetime, timezone
import uuid
import json


@dataclass
class IR Custom AIOSEvent:
    type: str
    source: str
    data: dict = field(default_factory=dict)
    tenant: str = "kevin"
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    metadata: dict = field(default_factory=dict)

    def to_stream(self) -> dict:
        return {
            "id": self.id,
            "type": self.type,
            "source": self.source,
            "tenant": self.tenant,
            "timestamp": self.timestamp,
            "data": json.dumps(self.data),
            "metadata": json.dumps(self.metadata),
        }

    @classmethod
    def from_stream(cls, entry: dict) -> "IR Custom AIOSEvent":
        return cls(
            id=entry.get("id", ""),
            type=entry.get("type", ""),
            source=entry.get("source", ""),
            tenant=entry.get("tenant", "kevin"),
            timestamp=entry.get("timestamp", ""),
            data=json.loads(entry.get("data", "{}")),
            metadata=json.loads(entry.get("metadata", "{}")),
        )
