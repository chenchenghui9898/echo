import type { PostContentType } from "@/lib/ai-lab/types";

export const CONTENT_SENSOR_EVALUATION_CASES: Array<{
  id: string;
  category: PostContentType;
  content: string;
  focus: string;
}> = [
  { id: "viewpoint-social", category: "观点", content: "我不赞成公司把下班后的即时回复当作责任心。紧急情况应该有值班制度，不能靠所有人随时在线。", focus: "明确社会/职场立场，应讨论论据和制度前提" },
  { id: "viewpoint-emotional", category: "观点", content: "每次看到有人说年轻人不肯吃苦我都很生气。很多所谓的吃苦，只是在替糟糕的管理找借口。", focus: "观点与愤怒并存，不能只安慰或只做抽象辩论" },
  { id: "mood-complaint", category: "心情", content: "电梯坏了，外卖又送错，刚坐下发现充电器还落在公司。今天到底在干吗。", focus: "日常吐槽，适合接话而非赏析或心理诊断" },
  { id: "mood-happy", category: "心情", content: "今天终于拿到 offer 了！回家的路上连红灯都觉得顺眼。", focus: "开心分享，优先祝贺，不需要安慰" },
  { id: "diary-setback", category: "日记", content: "准备两个月的面试没过。晚上把做过的题重新翻了一遍，发现最后一轮其实有三个问题都答得很含糊。失落是真的，但也知道下一步该补什么。", focus: "关注挫折、复盘和行动，不机械鼓励" },
  { id: "diary-success", category: "日记", content: "查到录取结果以后，我先给妈妈打了电话。她沉默了几秒，只说晚上多买两个菜。过去半年每天六点起床的事，忽然在那句话里有了结果。", focus: "经历、关系和成功并存，适合祝贺并关注细节" },
  { id: "diary-ordinary", category: "日记", content: "上午洗了床单，下午去修自行车。回来的时候买了一把小葱，老板多塞了两根。晚上把积了三天的杯子洗了。", focus: "普通生活记录，不应擅自判断孤独或治愈" },
  { id: "work-poem", category: "作品", content: "车站把人群一口一口吐出去 / 我站在原地 / 手里还捏着那张没有日期的票", focus: "以具体措辞和结构为主，可适度回应情感" },
  { id: "work-essay-opinion", category: "作品", content: "我们赞美忙碌，常常因为忙碌最容易被看见。沉默的思考没有打卡记录，却可能决定一件事最后做成什么样。", focus: "作品与观点混合，可兼顾表达和论点" },
  { id: "work-humorous", category: "作品", content: "我家的猫不懂经济学，但非常擅长通货膨胀：同一声喵，去年换一颗冻干，今年至少要三颗。", focus: "轻松创作，适合回应笑点，不应强行升华" },
];
