#!/usr/bin/env python3
"""
Aqara private cloud request signing — ĐÃ REVERSE XONG (5/5 mẫu khớp).

Nguồn: native Rust `Java_com_lumi_lumidevsdk_LumiDevSDK_getSignHead` trong liblumidevsdk.so.
Hàm nội bộ 0xa3a60 nhận 6 lát [appid, nonce, time, token, body, appKey] và build:

    pre = "Appid={appid}&Nonce={nonce}&Time={time}&Token={token}" + ("&"+body nếu body khác rỗng) + "&" + appKey
    sign = MD5(pre).hexdigest()           # 32 hex thường, KHÔNG đổi hoa/thường

- appid  : cố định theo app v6.1.6 = 444c476ef7135e53330f46e7
- appKey : SECRET hằng số            = uOJy0qmKwXj6aHUB2KQEIJuXHMDVTAJi   (lộ qua hook getSignHead)
- nonce  : 32 hex random mỗi request
- time   : epoch milliseconds (string)
- token  : session token (header 'token')
- body   : đúng chuỗi JSON body gửi đi (GET/empty → '')

Header gửi kèm mỗi request (rpc-au.aqara.com, HTTP/2): appid userid token sign nonce time area ...
"""
import hashlib

APPID  = "444c476ef7135e53330f46e7"
APPKEY = "uOJy0qmKwXj6aHUB2KQEIJuXHMDVTAJi"


def aqara_sign(nonce: str, time_ms: str, token: str, body: str = "",
               appid: str = APPID, appkey: str = APPKEY) -> str:
    pre = f"Appid={appid}&Nonce={nonce}&Time={time_ms}"
    if token:                       # token rỗng (login) → BỎ HẲN đoạn &Token=
        pre += f"&Token={token}"
    if body:
        pre += "&" + body
    pre += "&" + appkey
    return hashlib.md5(pre.encode()).hexdigest()


if __name__ == "__main__":
    # self-test (token = placeholder, KHÔNG phải token thật)
    assert aqara_sign("0B0187075D766E314F84651064EAA9F5", "1780500326614",
                      "EXAMPLE_TOKEN_NOT_REAL") == "dc78a059a00cb04b40f3bb94f5165c96"
    assert aqara_sign("2FC3F2D2EB9FB7E3C827B8E3AC839777", "1780499899899",
                      "EXAMPLE_TOKEN_NOT_REAL",
                      '{"data":[{"attach":null,"attrs":["set_video","P2P_capture_status"],"byResourceId":0,"resourceIds":null,"subjectId":"example.subject"}]}'
                      ) == "0b38a7b2cf3654fa59848407e31b922e"
    print("self-test OK ✅")
