export const SITE = {
  website: "https://alvaroacevedo.dev/",
  author: "Alvaro Acevedo",
  profile: "https://alvaroacevedo.dev/",
  desc: "Backend .NET + IA aplicada, en español. Construyo en público.",
  title: "Alvaro Acevedo",
  ogImage: "astropaper-og.jpg",
  lightAndDarkMode: true,
  postPerIndex: 4,
  postPerPage: 4,
  scheduledPostMargin: 15 * 60 * 1000, // 15 minutes
  showArchives: true,
  showBackButton: true,
  editPost: {
    enabled: true,
    text: "Editar artículo",
    url: "https://github.com/varocode/alvaroacevedo.dev/edit/main/",
  },
  dynamicOgImage: true,
  dir: "ltr",
  lang: "es",
  timezone: "America/Bogota",
} as const;
