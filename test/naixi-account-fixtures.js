export function accountHtml(points = "571", group = "中级会员") {
  return `<div id="comiis_user_menu"><div class="comiis_user_info"><div class="kmtxt">
    <a href="/home.php?mod=spacecp&amp;ac=usergroup">${group}</a>
    <a href="/home.php?mod=spacecp&amp;ac=credit">积分: ${points}</a></div></div>
    <a href="/member.php?mod=logging&amp;action=logout">退出</a></div>`;
}
export const signedPage = points => `<title>奶昔论坛</title>${accountHtml(points)}<p>您的签到排名：1</p><input id="lxreward" value="5"><input id="lxdays" value="2"><input id="lxtdays" value="8">`;
export const unsignedPage = `<title>奶昔论坛</title>${accountHtml()}<p>您今天还没有签到</p><a href="/plugin.php?operation=qiandao">立即签到</a>`;
