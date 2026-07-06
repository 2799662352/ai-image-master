"""创建 sakuga42m Collection(25 列全量 schema,零丢失)。幂等:已存在则直接 describe。"""
from common import DashVector

# parquet 列类型 → DashVector 字段类型
# string→STRING, double→FLOAT, int64→INT;identifier 同时作 doc id 与字段
FIELDS_SCHEMA = {
    "identifier": "STRING",
    "hash_identifier": "STRING",
    "url_link": "STRING",
    "scene_start_time": "STRING",
    "scene_end_time": "STRING",
    "frame_number": "FLOAT",
    "key_frame_number": "FLOAT",
    "anime_tags": "STRING",
    "user_tags": "STRING",
    "text_description": "STRING",
    "aesthetic_score": "FLOAT",
    "dynamic_score": "FLOAT",
    "rating": "STRING",
    "text_prob": "FLOAT",
    "width": "INT",
    "height": "INT",
    "file_ext": "STRING",
    "fps": "FLOAT",
    "Taxonomy_Time": "STRING",
    "Taxonomy_Venue": "STRING",
    "Taxonomy_Media": "STRING",
    "Taxonomy_Filming": "STRING",
    "Taxonomy_Composition": "STRING",
    "Taxonomy_Character": "STRING",
}


def main():
    dv = DashVector()
    r = dv.create_collection(FIELDS_SCHEMA)
    print("create:", r)
    d = dv.describe()
    print("describe:", d)


if __name__ == "__main__":
    main()
