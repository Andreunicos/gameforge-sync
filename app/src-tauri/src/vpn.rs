//! Redes virtuais deste PC (Radmin VPN, Tailscale, ZeroTier) para o Multi-User do Unreal achar o servidor sem digitar IP.
//! Lê as placas pela API do sistema (crate if-addrs: GetAdaptersAddresses no Windows), nunca pela saída do ipconfig
//! (que muda com o idioma do Windows). O nome é o da conexão (o que aparece em "Conexões de rede", ex.: "Radmin VPN").

use std::net::Ipv4Addr;
use std::time::{Duration, Instant};

#[derive(serde::Serialize, Debug, PartialEq)]
pub struct NetAddr {
    /// Nome da conexão no Windows.
    name: String,
    ip: String,
    /// Tamanho da máscara (26.x do Radmin = 8): a tela confere se o IP do host está na mesma rede.
    prefix: u8,
    /// "radmin", "tailscale", "zerotier" ou "" (placa comum).
    kind: &'static str,
}

/// Qual rede virtual é (pelo nome da conexão ou pela faixa de IP); "" = placa comum (Wi-Fi, cabo...).
/// Radmin VPN dá IPs 26.x; Tailscale, 100.64.0.0/10; ZeroTier não tem faixa fixa, só o nome.
pub fn kind(name: &str, ip: Ipv4Addr) -> &'static str {
    let n = name.to_lowercase();
    let [a, b, ..] = ip.octets();
    if n.contains("radmin") {
        "radmin"
    } else if n.contains("zerotier") {
        "zerotier"
    } else if n.contains("tailscale") {
        "tailscale"
    } else if a == 26 {
        "radmin"
    } else if a == 100 && (b & 0xC0) == 64 {
        "tailscale"
    } else {
        ""
    }
}

/// IPv4 das placas ligadas (sem loopback). Placa desligada (Radmin desconectado) não entra.
fn up_v4() -> std::io::Result<Vec<(String, Ipv4Addr, u8)>> {
    Ok(if_addrs::get_if_addrs()?
        .into_iter()
        .filter(|i| i.oper_status == if_addrs::IfOperStatus::Up && !i.is_loopback())
        .filter_map(|i| match i.addr {
            if_addrs::IfAddr::V4(a) => Some((i.name, a.ip, a.prefixlen)),
            _ => None,
        })
        .collect())
}

/// Endereços IPv4 deste PC, cada um marcado com o tipo de rede virtual (ou "" se é placa comum).
#[tauri::command(async)]
pub fn vpn_addrs() -> Result<Vec<NetAddr>, String> {
    let list = up_v4().map_err(|e| e.to_string())?;
    Ok(list.into_iter().map(|(name, ip, prefix)| NetAddr { kind: kind(&name, ip), name, ip: ip.to_string(), prefix }).collect())
}

/// O IP continua numa placa ligada deste PC? Erro ao ler as placas conta como "sim" (nunca derruba o servidor por engano).
pub fn has_ip(ip: Ipv4Addr) -> bool {
    up_v4().map(|l| l.iter().any(|(_, a, _)| *a == ip)).unwrap_or(true)
}

/// O IP está numa placa ligada de rede virtual deste PC (Radmin, Tailscale, ZeroTier)?
pub fn is_vpn_ip(ip: Ipv4Addr) -> bool {
    up_v4().is_ok_and(|l| l.iter().any(|(name, a, _)| *a == ip && !kind(name, *a).is_empty()))
}

/// Histerese da queda da VPN: devolve (desde quando o IP sumiu, já passou do prazo?). IP de volta zera a contagem,
/// então uma oscilação curta do Radmin não derruba nada.
pub fn lost(since: Option<Instant>, present: bool, now: Instant, grace: Duration) -> (Option<Instant>, bool) {
    if present {
        return (None, false);
    }
    let s = since.unwrap_or(now);
    (Some(s), now.duration_since(s) >= grace)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifica() {
        let ip = |s: &str| s.parse::<Ipv4Addr>().unwrap();
        assert_eq!(kind("Radmin VPN", ip("26.10.20.30")), "radmin");
        assert_eq!(kind("Ethernet 3", ip("26.10.20.30")), "radmin", "renomeada: vale a faixa 26.x");
        assert_eq!(kind("radmin vpn", ip("10.0.0.2")), "radmin");
        assert_eq!(kind("Tailscale", ip("100.101.102.103")), "tailscale");
        assert_eq!(kind("Ethernet 4", ip("100.64.0.1")), "tailscale");
        assert_eq!(kind("Ethernet 4", ip("100.127.255.254")), "tailscale");
        assert_eq!(kind("Ethernet 4", ip("100.128.0.1")), "", "fora de 100.64.0.0/10");
        assert_eq!(kind("Ethernet 4", ip("100.63.0.1")), "");
        assert_eq!(kind("ZeroTier One [8056c2e21c000001]", ip("10.147.17.5")), "zerotier");
        assert_eq!(kind("Wi-Fi", ip("192.168.0.10")), "");
        assert_eq!(kind("Ethernet", ip("25.1.2.3")), "");
        assert_eq!(kind("Ethernet", ip("27.1.2.3")), "");
    }

    #[test]
    fn lista_as_placas_deste_pc() {
        // Não depende de ter Radmin: só confere que a leitura funciona e que loopback não entra.
        let list = vpn_addrs().unwrap();
        assert!(list.iter().all(|a| a.ip != "127.0.0.1"));
        assert!(!has_ip(Ipv4Addr::new(203, 0, 113, 77)), "IP de documentação nunca está numa placa");
        for a in &list {
            assert!(has_ip(a.ip.parse().unwrap()), "{a:?}");
        }
    }

    #[test]
    fn histerese() {
        let t0 = Instant::now();
        let g = Duration::from_secs(10);
        let at = |s: u64| t0 + Duration::from_secs(s);
        assert_eq!(lost(None, true, at(0), g), (None, false));
        let (s, l) = lost(None, false, at(3), g); // sumiu
        assert_eq!((s, l), (Some(at(3)), false));
        let (s, l) = lost(s, false, at(9), g); // 6 s fora
        assert_eq!((s, l), (Some(at(3)), false));
        let (s, l) = lost(s, true, at(12), g); // voltou: zera
        assert_eq!((s, l), (None, false));
        let (s, _) = lost(s, false, at(15), g);
        let (s, l) = lost(s, false, at(24), g); // 9 s fora
        assert!(!l);
        let (_, l) = lost(s, false, at(25), g); // 10 s fora: cai
        assert!(l);
    }
}
