import { AquaraMobileClient } from "../client/AquaraMobileClient";
import { loginWithPasswordPlain } from "../client/loginPlain";
const area = "SEA";
const a = await loginWithPasswordPlain({ email: process.env.E!, password: process.env.P!, area });
const cloud = new AquaraMobileClient({ area, token: a.token, userId: a.userId });
const home = await cloud.get<any>("/app/position/query/home/list", { needDefaultRoom: "false", size: 300, startIndex: 0 });
for (const h of (home?.homes ?? [])) {
  const pid = h.positionId ?? h.homeId;
  // thử lấy nhiều trang để biết tổng thật
  let total = 0, test = 0, page = 0;
  for (let start = 0; start < 1000; start += 200) {
    const r = await cloud.get<any>("/app/position/linkage/query", { positionId: pid, size: 200, startIndex: start });
    const arr = r?.ifttts ?? r?.result?.ifttts ?? [];
    if (!arr.length) break;
    total += arr.length;
    test += arr.filter((x: any) => /__limit_test_/.test(x.name)).length;
    page++;
    // in raw count field nếu có
    if (start === 0) console.log(`home ${pid}: page0 arr=${arr.length} totalCountField=${r?.totalCount ?? r?.total ?? "n/a"}`);
  }
  console.log(`  → tổng linkage thật = ${total} (qua ${page} trang), trong đó __limit_test_ = ${test}`);
}
