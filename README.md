# Formwheel_Fate

랜덤한 선택과 결과를 이용해 플레이하는 운 게임.

- 실행: https://semicolonxss.github.io/Formwheel_Fate/
- 프로젝트 목록: https://semicolonxss.github.io/Formwheel/
- 진행 상태: https://semicolonxss.github.io/Formwheel_Check/

## 사용

브라우저에서 실행 링크를 여세요. 화면에 표시된 설명과 버튼으로 진행합니다. 온라인 기능은 Firebase 연결이 필요하며, 방 게임은 같은 코드로 참가합니다. 로컬 저장은 현재 브라우저에만 남습니다.

## 개발 및 검증

정적 HTML/JavaScript 프로젝트입니다. HTTP 서버로 제공하세요. Firebase 운영 설정·Rules는 이 저장소의 화면 파일만 배포해서 바뀌지 않습니다.

```sh
node scripts/check-syntax.cjs
```

첫 검사는 JavaScript 구문과 상대경로 파일 존재를 확인합니다. 모든 앱의 실제 멀티플레이와 운영 권한을 보증하는 검사는 아닙니다.

## 데이터 및 운영 보안

공통 안내: https://semicolonxss.github.io/Formwheel/privacy.html

닉네임·답안·점수·채팅 등이 서버에 저장될 수 있습니다. 새 보안 스키마와 서버 코드는 [Formwheel/firebase-security](https://github.com/SemicolonXSS/Formwheel/tree/main/firebase-security)에 준비했습니다. 현재 운영 적용 및 기존 경로 전환이 완료되었다고 가정하지 마세요. 계정/제공자 설정, 서버 보안 검증이 필요한 항목은 Check에서 별도로 남겨둡니다.

화면 마크업은 `index.html`, 앱별 스타일과 실행 코드는 `assets/`에 분리했습니다. 공통 UI는 Formwheel 저장소의 `shared/`를 사용합니다.

## 🎮 게임 가이드

**운명 카드 전략 게임** — 룰렛과 운명 카드의 효과를 활용하여 점수를 얻거나 다른 플레이어를 견제합니다.

### 플레이 방법

1. 방 생성 및 참가
2. 룰렛/카드 선택
3. 안전·탐욕·복수·스틸 등의 효과 적용
4. 라운드 결과와 최종 점수 확인

### 주요 기능

- 최대 6인
- 운명 카드
- 점수 탈취·교환 효과

> 지원 모드와 버튼 이름은 배포 버전에 따라 달라질 수 있습니다.
