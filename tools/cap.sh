#!/system/bin/sh
rm -f /sdcard/unlock.pcap
tcpdump -i wlan0 -n -U -s0 -w /sdcard/unlock.pcap net 192.168.2.0/24 and not host 192.168.2.2 and not port 5555
