import StudentCard from '../StudentCard';

export default function StudentCardExample() {
  // todo: remove mock functionality
  const mockStudent = {
    id: "1",
    name: "김영수",
    grade: "중2",
    school: "서울중학교",
    className: "영어 중급반",
    dueDay: 8,
    tuition: 150000,
    paymentStatus: 'paid' as const,
    parentPhone: "010-1234-5678"
  };

  const handleEdit = (id: string) => {
    console.log(`Edit student ${id}`);
  };

  const handlePayment = (id: string, month: 'current' | 'next') => {
    console.log(`Payment for student ${id} - ${month} month`);
  };

  return (
    <div className="max-w-md">
      <StudentCard 
        student={mockStudent}
        onEdit={handleEdit}
        onPayment={handlePayment}
      />
    </div>
  );
}