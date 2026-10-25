"""Home entry selection from the reviewed catalog, keyed by stable business IDs."""

# One entry per provincial-level region: provincial capitals, autonomous-region
# seats, the municipalities and special regions themselves, and Taipei.
# Explicit pinyin avoids locale-dependent ordering and polyphonic names such as
# Chongqing and Changchun. This selection neither changes nor reseeds the catalog.
PROVINCE_CENTERS = {
    "7e5c7d6b-2cda-4196-b4cc-21fe0ab5e5b6": "aomen",  # 澳门特别行政区
    "86584d70-97ea-42f0-9bd1-2992e4b8ad2c": "beijing",  # 北京市
    "b925bc95-e19d-40aa-9a6d-1f5b277c21e3": "changchun",  # 吉林省 · 长春市
    "079878ef-353d-4084-810c-1deca4035b12": "changsha",  # 湖南省 · 长沙市
    "2432f366-542d-42db-916b-494ceea5ec4c": "chengdu",  # 四川省 · 成都市
    "a85085f7-1b55-4786-989a-5931e4dc7ed5": "chongqing",  # 重庆市
    "f9f7abee-25c9-4460-a51e-5b4b1bc2be8a": "fuzhou",  # 福建省 · 福州市
    "a03b8f10-06dd-4b56-aef1-33cfc3696302": "guangzhou",  # 广东省 · 广州市
    "6cb1d0d4-a87d-4913-a4c9-b04178927fe6": "guiyang",  # 贵州省 · 贵阳市
    "010dfbbe-e67c-4b9a-b380-7ef8d8e69da3": "haerbin",  # 黑龙江省 · 哈尔滨市
    "c19528eb-33dd-4d68-8753-91149741d1cb": "haikou",  # 海南省 · 海口市
    "10e420cd-4d49-4b22-a489-2027de09ec97": "hangzhou",  # 浙江省 · 杭州市
    "77a1d9a5-bd32-4b27-918e-29be2868549c": "hefei",  # 安徽省 · 合肥市
    "2898d4b8-e42c-4ef7-8d07-4d893f791e83": "huhehaote",  # 内蒙古自治区 · 呼和浩特市
    "87ccf5c3-cca5-49f9-ba4d-cbca9433ab85": "jinan",  # 山东省 · 济南市
    "c663601b-2125-4a6d-8c33-67ff0061264f": "kunming",  # 云南省 · 昆明市
    "76d834ac-2dfb-41d4-8f19-add56b9eb3c7": "lanzhou",  # 甘肃省 · 兰州市
    "4e00fa9a-b75a-4f1f-a6aa-8b7e68698581": "lasa",  # 西藏自治区 · 拉萨市
    "f129ab14-f2c2-4415-b3be-d6128a539618": "nanchang",  # 江西省 · 南昌市
    "d3d0acb0-3942-49d7-ab58-9733e26369dc": "nanjing",  # 江苏省 · 南京市
    "b836b45b-97a0-4f89-9104-dd877b36b1e9": "nanning",  # 广西壮族自治区 · 南宁市
    "f924849c-aa07-40f9-83c4-d0dac8fb3b97": "shanghai",  # 上海市
    "f94b50db-d40c-472e-a46a-6fe1a200f9c1": "shenyang",  # 辽宁省 · 沈阳市
    "d85532c4-c04b-4382-b41d-a2bd6d1b4fd0": "shijiazhuang",  # 河北省 · 石家庄市
    "8c625a03-5fe7-460e-9a8f-6edfbb65b9ca": "taibei",  # 台湾省 · 台北市
    "447e5cf9-0d9c-41c9-a069-ba5f0c1f1693": "taiyuan",  # 山西省 · 太原市
    "b6040d88-d790-44e9-8086-7bdce11db402": "tianjin",  # 天津市
    "1a1a0fe4-b3af-4ff4-a30e-0fe9cd74171f": "wuhan",  # 湖北省 · 武汉市
    "19a6a391-074d-411d-b217-18cfd2a7cae3": "wulumuqi",  # 新疆维吾尔自治区 · 乌鲁木齐市
    "80ffe11b-b23a-4687-90ec-2ccd309e0a13": "xian",  # 陕西省 · 西安市
    "36db7ccf-73b1-48a0-b4ca-7f8623fac61f": "xianggang",  # 香港特别行政区
    "ad007b47-51bd-4e22-9a12-e3b85e4dc1b7": "xining",  # 青海省 · 西宁市
    "725976e6-00a4-4f98-a1af-25ef508dfe0a": "yinchuan",  # 宁夏回族自治区 · 银川市
    "da11da1f-04e2-4118-b2d6-3f0afd226307": "zhengzhou",  # 河南省 · 郑州市
}
